import { ArcElement, BarController, BarElement, CategoryScale, Chart, type ChartConfiguration, DoughnutController, Legend, LinearScale, LineController, LineElement, PointElement, Tooltip } from 'chart.js';
import htm from 'htm';
import { h, render, type VNode } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { formatDuration, relativeTime, UNTITLED } from '../../ui/format';
import { closeDropdownsOnOutsideClick, MultiSelect } from '../shared/controls';
import { BUCKETS, type StatsFilterMessage, StatsHostToWebviewSchema, type StatsResultMessage, type StatsTable, type StatsWebviewToHost } from '../stats-protocol';

/** Statistics webview (§9.2). Data arrives validated; Preact renders text escaped; Chart.js is bundled (R9.2). */

declare function acquireVsCodeApi(): { postMessage(m: StatsWebviewToHost): void; getState(): unknown; setState(s: unknown): void };

Chart.register(BarController, BarElement, LineController, LineElement, PointElement, DoughnutController, ArcElement, CategoryScale, LinearScale, Tooltip, Legend);

const vscode = acquireVsCodeApi();
const html = htm.bind(h);
const DAY = 86_400_000;
const SOURCE_LABELS: Record<string, string> = { vscode: 'VS Code', 'vscode-insiders': 'Insiders', 'copilot-cli': 'Copilot CLI' };
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const PRESETS = [
  { id: 'all', label: 'All time', days: undefined },
  { id: '7d', label: 'Last 7 days', days: 7 },
  { id: '30d', label: 'Last 30 days', days: 30 },
  { id: '90d', label: 'Last 90 days', days: 90 },
  { id: '1y', label: 'Last year', days: 365 },
  { id: 'custom', label: 'Custom…', days: undefined },
] as const;
type Preset = (typeof PRESETS)[number]['id'];
type Bucket = (typeof BUCKETS)[number];
type ShareKey = 'models' | 'modes';
type ShareRows = StatsResultMessage['models'];

interface UiFilter {
  preset: Preset;
  /** Custom range as local YYYY-MM-DD, both inclusive. */
  from?: string;
  to?: string;
  sources: string[];
  groups: string[];
  models: string[];
  modes: string[];
  bucket: Bucket;
}

const EMPTY_FILTER: UiFilter = { preset: 'all', sources: [], groups: [], models: [], modes: [], bucket: 'auto' };

function loadState(): UiFilter {
  const s = vscode.getState() as Partial<UiFilter> | undefined;
  if (!s || typeof s !== 'object') return EMPTY_FILTER;
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  return {
    preset: PRESETS.some((p) => p.id === s.preset) ? (s.preset as Preset) : 'all',
    from: typeof s.from === 'string' ? s.from : undefined,
    to: typeof s.to === 'string' ? s.to : undefined,
    sources: arr(s.sources),
    groups: arr(s.groups),
    models: arr(s.models),
    modes: arr(s.modes),
    bucket: BUCKETS.includes(s.bucket as Bucket) ? (s.bucket as Bucket) : 'auto',
  };
}

const localMidnight = (ymd: string | undefined): number | undefined => {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return undefined;
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d).getTime();
};

/** UI filter → message filter; relative presets are resolved now, so a reopened view stays relative. */
function toMessage(f: UiFilter): StatsFilterMessage {
  const preset = PRESETS.find((p) => p.id === f.preset);
  const after = f.preset === 'custom' ? localMidnight(f.from) : preset?.days ? Date.now() - preset.days * DAY : undefined;
  const to = f.preset === 'custom' ? localMidnight(f.to) : undefined;
  return { after, before: to === undefined ? undefined : to + DAY, sources: f.sources, groups: f.groups, models: f.models, modes: f.modes, bucket: f.bucket };
}

const dash = (n: number | null | undefined, digits = 0): string => (n === null || n === undefined ? '—' : n.toLocaleString(undefined, { maximumFractionDigits: digits }));
const pct = (n: number | null): string => (n === null ? '—' : `${Math.round(n * 100)} %`);
const nameOr = (name: string): string => name || '(not recorded)';

/** Theme colors from VS Code's chart palette (R9.2). */
function palette(): { fg: string; lines: string; series: string[] } {
  const css = getComputedStyle(document.body);
  const v = (name: string, fallback: string): string => css.getPropertyValue(name).trim() || fallback;
  return {
    fg: v('--vscode-charts-foreground', v('--vscode-foreground', '#888')),
    lines: v('--vscode-charts-lines', 'rgba(128,128,128,0.3)'),
    series: [
      v('--vscode-charts-blue', '#3794ff'),
      v('--vscode-charts-purple', '#b180d7'),
      v('--vscode-charts-green', '#89d185'),
      v('--vscode-charts-orange', '#d18616'),
      v('--vscode-charts-yellow', '#cca700'),
      v('--vscode-charts-red', '#f14c4c'),
    ],
  };
}

function ChartBox({ config, label }: { config: ChartConfiguration; label: string }): VNode {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const chart = new Chart(canvas.current!, config);
    return () => chart.destroy();
  }, [config]);
  return html`<div class="chart"><canvas ref=${canvas} role="img" aria-label=${label}></canvas></div>` as VNode;
}

function Widget(props: { title: string; table: StatsTable; onExport: (t: StatsTable) => void; wide?: boolean; children?: unknown }): VNode {
  return html`
    <section class=${props.wide ? 'widget wide' : 'widget'}>
      <div class="widget-head">
        <h2>${props.title}</h2>
        <button class="link" title="Export this table as CSV" onClick=${() => props.onExport(props.table)}>Export CSV</button>
      </div>
      ${props.children}
    </section>
  ` as VNode;
}

function Kpis({ k }: { k: StatsResultMessage['kpis'] }): VNode {
  const cards: [string, string, string?][] = [
    ['Sessions', dash(k.sessions)],
    ['Prompts', `${dash(k.meaningfulPrompts)} / ${dash(k.prompts)}`, 'meaningful / total'],
    ['Turns', dash(k.turns), `${dash(k.canceled)} canceled`],
    ['Tool calls', dash(k.toolCalls)],
    ['Active days', dash(k.activeDays)],
    ['Avg prompts / session', dash(k.avgPromptsPerSession, 1)],
    ['Tokens in / out', `${dash(k.promptTokens)} / ${dash(k.completionTokens)}`, `coverage ${pct(k.tokenCoverage)}`],
    ['Credits', dash(k.credits, 2), `coverage ${pct(k.creditCoverage)}`],
  ];
  return html`<div class="kpis">
    ${cards.map(
      ([label, value, sub]) =>
        html`<div class="kpi">
          <div class="kpi-value">${value}</div>
          <div class="kpi-label">${label}</div>
          ${sub ? html`<div class="meta">${sub}</div>` : ''}
        </div>`,
    )}
  </div>` as VNode;
}

const heatClass = (n: number, max: number): string => (!n || !max ? 'h0' : `h${Math.max(1, Math.ceil((n / max) * 5))}`);

/** A table row that acts on click or Enter. */
function ClickRow(props: { title: string; onActivate: () => void; children?: unknown }): VNode {
  return html`<tr class="clickable" tabindex="0" title=${props.title} onClick=${props.onActivate} onKeyDown=${(e: KeyboardEvent) => e.key === 'Enter' && props.onActivate()}>
    ${props.children}
  </tr>` as VNode;
}

function ShareTable(props: { rows: ShareRows; label: string; onPick: (name: string) => void }): VNode {
  const total = props.rows.reduce((n, r) => n + r.turns, 0);
  return html`<table class="grid">
    <thead>
      <tr><th>${props.label}</th><th class="num">Turns</th><th class="num">Share</th><th class="num">Credits</th></tr>
    </thead>
    <tbody>
      ${props.rows.map(
        (r) => html`<${ClickRow} title="Filter by this value" onActivate=${() => props.onPick(r.name)}>
          <td>${nameOr(r.name)}</td>
          <td class="num">${dash(r.turns)}</td>
          <td class="num">${total ? `${Math.round((r.turns / total) * 100)} %` : '—'}</td>
          <td class="num">${dash(r.credits, 2)}</td>
        </${ClickRow}>`,
      )}
    </tbody>
  </table>` as VNode;
}

function App(): VNode {
  const [filter, setFilter] = useState<UiFilter>(loadState);
  const [data, setData] = useState<StatsResultMessage | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [topTab, setTopTab] = useState<'byPrompts' | 'byCredits' | 'byDuration'>('byPrompts');
  const nextId = useRef(1);
  const latest = useRef(0);
  const reported = useRef(false);
  const live = useRef(filter);
  live.current = filter;

  const query = (f: UiFilter): void => {
    const requestId = nextId.current++;
    latest.current = requestId;
    setBusy(true);
    vscode.postMessage({ type: 'query', requestId, filter: toMessage(f) });
  };

  const update = (patch: Partial<UiFilter>): void => {
    const next = { ...live.current, ...patch };
    setFilter(next);
    vscode.setState(next);
    query(next);
  };

  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      const parsed = StatsHostToWebviewSchema.safeParse(e.data);
      if (!parsed.success) return;
      const m = parsed.data;
      if (m.type === 'init') {
        query(live.current);
      } else if (m.type === 'data') {
        if (m.requestId !== latest.current) return;
        setBusy(false);
        setError(undefined);
        setData(m.result);
        if (!reported.current) {
          reported.current = true;
          // N5 – charts draw synchronously (animation off); report once the browser has painted them.
          requestAnimationFrame(() => requestAnimationFrame(() => vscode.postMessage({ type: 'rendered', requestId: m.requestId })));
        }
      } else if (m.requestId === undefined || m.requestId === latest.current) {
        setBusy(false);
        setError(m.message);
      }
    };
    window.addEventListener('message', onMessage);
    vscode.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);
  useEffect(closeDropdownsOnOutsideClick, []);

  const exportTable = (table: StatsTable): void => vscode.postMessage({ type: 'export', table, filter: toMessage(live.current) });
  const pickShare = (key: ShareKey) => (name: string) => update({ [key]: [name] });

  const charts = useMemo(() => {
    if (!data) return undefined;
    const colors = palette();
    Chart.defaults.color = colors.fg;
    Chart.defaults.borderColor = colors.lines;
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
    const color = (i: number): string => colors.series[i % colors.series.length]!;
    const buckets = [...new Set(data.activity.map((a) => a.bucket))].sort();
    const sources = [...new Set(data.activity.map((a) => a.source))];
    const credits = buckets.map((b) => {
      const rows = data.activity.filter((a) => a.bucket === b && a.credits !== null);
      return rows.length ? rows.reduce((n, a) => n + (a.credits ?? 0), 0) : null;
    });
    const activity: ChartConfiguration = {
      type: 'bar',
      data: {
        labels: buckets,
        datasets: [
          ...sources.map((s, i) => ({
            type: 'bar' as const,
            label: `Prompts – ${SOURCE_LABELS[s] ?? s}`,
            data: buckets.map((b) => data.activity.find((a) => a.bucket === b && a.source === s)?.prompts ?? 0),
            backgroundColor: color(i),
            stack: 'prompts',
            yAxisID: 'y',
          })),
          { type: 'line' as const, label: 'Credits', data: credits, borderColor: color(3), backgroundColor: color(3), yAxisID: 'y1', spanGaps: true },
        ],
      },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: { stacked: true },
          y: { stacked: true, beginAtZero: true, title: { display: true, text: 'Prompts' } },
          y1: { position: 'right', beginAtZero: true, grid: { drawOnChartArea: false }, title: { display: true, text: 'Credits' } },
        },
      },
    };
    const doughnut = (rows: ShareRows, key: ShareKey): ChartConfiguration => ({
      type: 'doughnut',
      data: { labels: rows.map((r) => nameOr(r.name)), datasets: [{ data: rows.map((r) => r.turns), backgroundColor: rows.map((_, i) => color(i)) }] },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'right' } },
        onClick: (_e, els) => {
          const r = rows[els[0]?.index ?? -1];
          if (r) pickShare(key)(r.name);
        },
      },
    });
    const tools: ChartConfiguration = {
      type: 'bar',
      data: { labels: data.tools.map((t) => t.tool), datasets: [{ label: 'Calls', data: data.tools.map((t) => t.calls), backgroundColor: color(0) }] },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: 'y',
        plugins: { legend: { display: false } },
        onClick: (_e, els) => {
          const t = data.tools[els[0]?.index ?? -1];
          if (t) vscode.postMessage({ type: 'searchTool', tool: t.tool });
        },
      },
    };
    return { activity, models: doughnut(data.models, 'models'), modes: doughnut(data.modes, 'modes'), tools };
  }, [data]);

  const groupLabel = (id: string): string => data?.facets.groups.find((g) => g.id === id)?.label ?? id;
  const presetLabel = filter.preset === 'custom' ? `${filter.from ?? '…'} – ${filter.to ?? '…'}` : PRESETS.find((p) => p.id === filter.preset)!.label;
  const heatMax = data ? Math.max(0, ...data.heatmap.flat()) : 0;
  const top = data?.top[topTab] ?? [];
  const tabs = [
    ['byPrompts', 'By prompts'],
    ['byCredits', 'By credits'],
    ['byDuration', 'By duration'],
  ] as const;

  return html`
    <header>
      <div class="filters">
        <details class="dropdown">
          <summary class=${filter.preset !== 'all' ? 'active' : ''}>${presetLabel}</summary>
          <div class="menu">
            ${PRESETS.map((p) => html`<label class="option"><input type="radio" name="preset" checked=${filter.preset === p.id} onChange=${() => update({ preset: p.id })} /> ${p.label}</label>`)}
            ${filter.preset === 'custom'
              ? html`<label class="option">From <input type="date" value=${filter.from ?? ''} onChange=${(e: Event) => update({ from: (e.target as HTMLInputElement).value || undefined })} /></label>
                  <label class="option">To <input type="date" value=${filter.to ?? ''} onChange=${(e: Event) => update({ to: (e.target as HTMLInputElement).value || undefined })} /></label>`
              : ''}
          </div>
        </details>
        <${MultiSelect} label="Source" options=${data?.facets.sources ?? []} selected=${filter.sources} display=${(v: string) => SOURCE_LABELS[v] ?? v} onChange=${(v: string[]) => update({ sources: v })} />
        <${MultiSelect} label="Workspace" options=${data?.facets.groups.map((g) => g.id) ?? []} selected=${filter.groups} display=${groupLabel} onChange=${(v: string[]) => update({ groups: v })} />
        <${MultiSelect} label="Model" options=${data?.facets.models ?? []} selected=${filter.models} display=${nameOr} onChange=${(v: string[]) => update({ models: v })} />
        <${MultiSelect} label="Mode" options=${data?.facets.modes ?? []} selected=${filter.modes} display=${nameOr} onChange=${(v: string[]) => update({ modes: v })} />
        <label class="option"
          >Buckets
          <select value=${filter.bucket} onChange=${(e: Event) => update({ bucket: (e.target as HTMLSelectElement).value as Bucket })}>
            ${BUCKETS.map((b) => html`<option value=${b}>${b === 'auto' ? `auto (${data?.bucket ?? 'day'})` : b}</option>`)}
          </select>
        </label>
        <button class="secondary" onClick=${() => update({ ...EMPTY_FILTER })}>Reset</button>
        <span class="meta">${busy ? 'Loading…' : data ? `${Math.round(data.tookMs)} ms` : ''}</span>
      </div>
    </header>
    ${error ? html`<div class="warning">${error}</div>` : ''}
    ${data && charts
      ? html`<main class="widgets">
          <${Widget} title="Overview" table="kpis" onExport=${exportTable} wide=${true}><${Kpis} k=${data.kpis} /></${Widget}>
          <${Widget} title=${`Activity per ${data.bucket}`} table="activity" onExport=${exportTable} wide=${true}>
            ${data.activity.length ? html`<${ChartBox} config=${charts.activity} label="Prompts per period by source, and credits" />` : html`<div class="meta">—</div>`}
          </${Widget}>
          <${Widget} title="Workspaces" table="workspaces" onExport=${exportTable} wide=${true}>
            <table class="grid">
              <thead>
                <tr><th>Workspace</th><th class="num">Sessions</th><th class="num">Prompts</th><th class="num">Credits</th><th>Last activity</th></tr>
              </thead>
              <tbody>
                ${data.workspaces.map(
                  (w) => html`<${ClickRow} title="Filter by this workspace" onActivate=${() => update({ groups: [w.id] })}>
                    <td>${w.label}</td>
                    <td class="num">${dash(w.sessions)}</td>
                    <td class="num">${dash(w.prompts)}</td>
                    <td class="num">${dash(w.credits, 2)}</td>
                    <td>${relativeTime(w.lastActivityAt)}</td>
                  </${ClickRow}>`,
                )}
              </tbody>
            </table>
          </${Widget}>
          <${Widget} title="Models" table="models" onExport=${exportTable}>
            ${data.models.length ? html`<${ChartBox} config=${charts.models} label="Share of turns per model" />` : ''}
            <${ShareTable} rows=${data.models} label="Model" onPick=${pickShare('models')} />
          </${Widget}>
          <${Widget} title="Modes and agents" table="modes" onExport=${exportTable}>
            ${data.modes.length ? html`<${ChartBox} config=${charts.modes} label="Share of turns per mode" />` : ''}
            <${ShareTable} rows=${data.modes} label="Mode" onPick=${pickShare('modes')} />
          </${Widget}>
          <${Widget} title="Top tools" table="tools" onExport=${exportTable}>
            ${data.tools.length ? html`<${ChartBox} config=${charts.tools} label="Top 20 tools by calls; click a bar to search for it" />` : html`<div class="meta">—</div>`}
            <div class="tools">
              ${data.tools.map((t) => html`<button class="link" title="Search sessions that used this tool" onClick=${() => vscode.postMessage({ type: 'searchTool', tool: t.tool })}>${t.tool} (${t.calls})</button>`)}
            </div>
          </${Widget}>
          <${Widget} title="Prompts by hour and weekday (local time)" table="heatmap" onExport=${exportTable}>
            <table class="heatmap" aria-label="Prompts by weekday and hour">
              <thead>
                <tr><th></th>${Array.from({ length: 24 }, (_, hr) => html`<th>${hr % 3 === 0 ? hr : ''}</th>`)}</tr>
              </thead>
              <tbody>
                ${data.heatmap.map((row, d) => html`<tr><th>${DAYS[d]}</th>${row.map((n, hr) => html`<td class=${heatClass(n, heatMax)} title=${`${DAYS[d]} ${hr}:00 – ${n} prompts`}></td>`)}</tr>`)}
              </tbody>
            </table>
          </${Widget}>
          <${Widget} title="Top sessions" table="top" onExport=${exportTable}>
            <div class="tabs" role="tablist">
              ${tabs.map(([id, label]) => html`<button role="tab" aria-selected=${topTab === id} class=${topTab === id ? 'tab active' : 'tab'} onClick=${() => setTopTab(id)}>${label}</button>`)}
            </div>
            <table class="grid">
              <thead>
                <tr><th>Session</th><th>Workspace</th><th class="num">Prompts</th><th class="num">Credits</th><th class="num">Duration</th></tr>
              </thead>
              <tbody>
                ${top.map(
                  (s) => html`<${ClickRow} title="Preview this session" onActivate=${() => vscode.postMessage({ type: 'openSession', key: s.key })}>
                    <td>${s.source === 'copilot-cli' ? html`<span class="badge">CLI</span> ` : ''}${s.title || UNTITLED}</td>
                    <td>${s.workspaceName}</td>
                    <td class="num">${dash(s.prompts)}</td>
                    <td class="num">${dash(s.credits, 2)}</td>
                    <td class="num">${formatDuration(s.durationMs)}</td>
                  </${ClickRow}>`,
                )}
              </tbody>
            </table>
            ${top.length ? '' : html`<div class="meta">—</div>`}
          </${Widget}>
        </main>`
      : !error
        ? html`<div class="meta loading">Loading statistics…</div>`
        : ''}
  ` as VNode;
}

render(html`<${App} />` as VNode, document.getElementById('app')!);
