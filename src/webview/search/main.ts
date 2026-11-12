import htm from 'htm';
import { h, render, type VNode } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { FilterKey } from '../../query/parse';
import { COLUMNS, type Column, type QueryControls, setControl, splitQuery } from '../../query/query-text';
import { relativeTime, shortModel, UNTITLED } from '../../ui/format';
import { type PanelFacets, type PanelResult, SearchHostToWebviewSchema, type SearchWebviewToHost, SORT_VALUES } from '../search-protocol';

/** Search Panel webview (§7.3). All data arrives via validated messages; Preact renders text escaped. */

declare function acquireVsCodeApi(): { postMessage(m: SearchWebviewToHost): void; getState(): unknown; setState(s: unknown): void };

const vscode = acquireVsCodeApi();
const html = htm.bind(h);
const DEBOUNCE_MS = 150;
type Sort = (typeof SORT_VALUES)[number];
type Action = 'open' | 'preview' | 'newWindow' | 'copyResume';

const SOURCE_LABELS: Record<string, string> = { vscode: 'VS Code', 'vscode-insiders': 'Insiders', 'copilot-cli': 'Copilot CLI' };
const SORT_LABELS: Record<Sort, string> = { relevance: 'Relevance', newest: 'Newest', oldest: 'Oldest', prompts: 'Prompts', credits: 'Credits' };
const HIT_LABELS: Record<string, string> = { prompt: 'You', response: 'Copilot', tools: 'Tools', files: 'Files', title: 'Title' };
const DATE_PRESETS: { label: string; value: string | undefined }[] = [
  { label: 'Any time', value: undefined },
  { label: 'Last 7 days', value: '7d' },
  { label: 'Last 30 days', value: '30d' },
  { label: 'Last 90 days', value: '90d' },
  { label: 'Last year', value: '1y' },
];
const HELP: [string, string][] = [
  ['word other', 'both words (AND)'],
  ['"exact phrase"', 'phrase'],
  ['a OR b', 'either'],
  ['-word', 'exclude'],
  ['pref*', 'prefix (2+ characters)'],
  ['~word', 'fuzzy: similar words too'],
  ['ws:name', 'workspace name contains'],
  ['src:vscode | insiders | cli', 'source'],
  ['model:  mode:  tool:  file:', 'contains'],
  ['in:prompt,response,tools,files,title', 'search only these fields'],
  ['after:2026-01-31  before:30d', 'date (YYYY-MM-DD, or 7d, 2w, 3m, 1y ago)'],
];

interface SavedState {
  query: string;
  sort: Sort;
  scrollY?: number;
}

interface Results {
  total: number;
  totalTurns?: number;
  tookMs: number;
  fuzzy: boolean;
  suggestion?: string;
  warnings: string[];
  items: PanelResult[];
}

function loadState(): SavedState | undefined {
  const s = vscode.getState() as Partial<SavedState> | undefined;
  if (!s || typeof s.query !== 'string') return undefined;
  return { query: s.query, sort: SORT_VALUES.includes(s.sort as Sort) ? (s.sort as Sort) : 'relevance', scrollY: typeof s.scrollY === 'number' ? s.scrollY : undefined };
}

/** Snippet text with \x01…\x02 markers as text plus <mark> nodes – never HTML (R6.10). */
function Snippet({ text }: { text: string }): VNode {
  const parts: (string | VNode)[] = [];
  let rest = text;
  while (rest) {
    const s = rest.indexOf('\u0001');
    if (s < 0) {
      parts.push(rest);
      break;
    }
    const e = rest.indexOf('\u0002', s + 1);
    parts.push(rest.slice(0, s), html`<mark>${rest.slice(s + 1, e < 0 ? undefined : e)}</mark>` as VNode);
    rest = e < 0 ? '' : rest.slice(e + 1);
  }
  return html`<span class="snippet">${parts}</span>` as VNode;
}

interface MultiSelectProps {
  label: string;
  options: readonly string[];
  selected: readonly string[];
  display?: (v: string) => string;
  onChange: (values: string[]) => void;
}

function MultiSelect(props: MultiSelectProps): VNode {
  const [filter, setFilter] = useState('');
  const display = props.display ?? ((v: string): string => v);
  const options = [...new Set([...props.selected, ...props.options])];
  const shown = filter ? options.filter((o) => display(o).toLowerCase().includes(filter.toLowerCase())) : options;
  const toggle = (v: string, on: boolean): void => props.onChange(on ? [...props.selected, v] : props.selected.filter((x) => x !== v));
  const n = props.selected.length;
  return html`
    <details class="dropdown">
      <summary class=${n ? 'active' : ''}>${props.label}${n ? ` (${n})` : ''}</summary>
      <div class="menu">
        ${options.length > 10 ? html`<input class="menu-filter" placeholder="Filter…" aria-label=${`Filter ${props.label}`} value=${filter} onInput=${(e: Event) => setFilter((e.target as HTMLInputElement).value)} />` : ''}
        ${shown.length === 0 ? html`<div class="meta">No values</div>` : ''}
        ${shown.map(
          (o) => html`<label class="option"><input type="checkbox" checked=${props.selected.includes(o)} onChange=${(e: Event) => toggle(o, (e.target as HTMLInputElement).checked)} /> ${display(o)}</label>`,
        )}
        ${n ? html`<button class="link" onClick=${() => props.onChange([])}>Clear</button>` : ''}
      </div>
    </details>
  ` as VNode;
}

function DateSelect(props: { controls: QueryControls; onChange: (after: string | undefined, before: string | undefined) => void }): VNode {
  const { after, before } = props.controls;
  const isDate = (v: string | undefined): v is string => v !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const parts = [after && `after ${after}`, before && `before ${before}`].filter(Boolean);
  return html`
    <details class="dropdown">
      <summary class=${parts.length ? 'active' : ''}>Date${parts.length ? ` (${parts.join(', ')})` : ''}</summary>
      <div class="menu">
        ${DATE_PRESETS.map(
          (p) => html`<label class="option"><input type="radio" name="date" checked=${after === p.value && !before} onChange=${() => props.onChange(p.value, undefined)} /> ${p.label}</label>`,
        )}
        <label class="option">After <input type="date" value=${isDate(after) ? after : ''} onChange=${(e: Event) => props.onChange((e.target as HTMLInputElement).value || undefined, before)} /></label>
        <label class="option">Before <input type="date" value=${isDate(before) ? before : ''} onChange=${(e: Event) => props.onChange(after, (e.target as HTMLInputElement).value || undefined)} /></label>
      </div>
    </details>
  ` as VNode;
}

function App(): VNode {
  const saved = useMemo(loadState, []);
  const [query, setQuery] = useState(saved?.query ?? '');
  const [applied, setApplied] = useState(saved?.query ?? '');
  const [sort, setSort] = useState<Sort>(saved?.sort ?? 'relevance');
  const [facets, setFacets] = useState<PanelFacets>({ sources: [], workspaces: [], models: [], modes: [] });
  const [history, setHistory] = useState<string[]>([]);
  const [scope, setScope] = useState<string | undefined>();
  const [results, setResults] = useState<Results | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [active, setActive] = useState(0);
  const [help, setHelp] = useState(false);
  const nextId = useRef(1);
  const latest = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const list = useRef<HTMLOListElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const restoreScroll = useRef(saved?.scrollY);
  // Handlers registered once read the latest values through this ref.
  const live = useRef({ query, sort });
  live.current = { query, sort };

  const controls = useMemo(() => splitQuery(applied).controls, [applied]);

  const run = (q: string, s: Sort, offset = 0): void => {
    const requestId = nextId.current++;
    latest.current = requestId;
    setBusy(true);
    vscode.postMessage({ type: 'search', requestId, query: q, sort: s, offset });
  };

  const runNow = (q: string, s: Sort = live.current.sort): void => {
    if (timer.current) clearTimeout(timer.current);
    setQuery(q);
    setApplied(q);
    run(q, s);
  };

  const commit = (q: string = live.current.query): void => vscode.postMessage({ type: 'commit', query: q });

  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      const parsed = SearchHostToWebviewSchema.safeParse(e.data);
      if (!parsed.success) return;
      const m = parsed.data;
      switch (m.type) {
        case 'init':
          setFacets(m.facets);
          setHistory(m.history);
          setScope(m.scope?.label);
          if (m.query !== undefined) restoreScroll.current = undefined;
          runNow(m.query ?? live.current.query);
          input.current?.focus();
          return;
        case 'results':
          if (m.requestId !== latest.current) return;
          setBusy(false);
          setError(undefined);
          setResults((prev) => ({
            total: m.total,
            totalTurns: m.totalTurns,
            tookMs: m.tookMs,
            fuzzy: m.fuzzy,
            suggestion: m.suggestion,
            warnings: m.warnings,
            items: m.offset > 0 && prev ? [...prev.items, ...m.results] : m.results,
          }));
          if (m.offset === 0) setActive(0);
          return;
        case 'history':
          setHistory(m.history);
          return;
        case 'error':
          if (m.requestId !== undefined && m.requestId !== latest.current) return;
          setBusy(false);
          setError(m.message);
      }
    };
    window.addEventListener('message', onMessage);
    vscode.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Dropdowns are <details>: close them on an outside click or Escape.
  useEffect(() => {
    const close = (keep?: EventTarget | null): void => {
      for (const d of document.querySelectorAll('details.dropdown[open]')) if (!(keep instanceof Node && d.contains(keep))) d.removeAttribute('open');
    };
    const onClick = (e: MouseEvent): void => close(e.target);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  // R7.19 – the panel is not retained when hidden; query, sort and scroll position come back via setState.
  useEffect(() => {
    const save = (): void => vscode.setState({ query: live.current.query, sort: live.current.sort, scrollY: window.scrollY } satisfies SavedState);
    save();
    window.addEventListener('scroll', save, { passive: true });
    return () => window.removeEventListener('scroll', save);
  }, [query, sort]);

  useEffect(() => {
    if (results && restoreScroll.current !== undefined) {
      window.scrollTo(0, restoreScroll.current);
      restoreScroll.current = undefined;
    }
  }, [results]);

  const onInput = (q: string): void => {
    setQuery(q);
    if (timer.current) clearTimeout(timer.current);
    // R7.13 – typing re-derives the controls and runs the query, debounced.
    timer.current = setTimeout(() => {
      setApplied(q);
      run(q, live.current.sort);
    }, DEBOUNCE_MS);
  };

  const editControl = (key: FilterKey, next: QueryControls): void => runNow(setControl(query, key, next));

  const act = (r: PanelResult, action: Action, turnIndex?: number): void => {
    commit();
    vscode.postMessage({ type: 'action', key: r.key, action, turnIndex });
  };

  const items = results?.items ?? [];
  const focusItem = (i: number): void => {
    if (!items.length) return;
    const n = Math.max(0, Math.min(items.length - 1, i));
    setActive(n);
    (list.current?.children[n] as HTMLElement | undefined)?.focus();
  };

  // R7.16 – ↑/↓ navigate, Enter open, Space preview, Cmd/Ctrl+Enter new window.
  const onItemKey = (e: KeyboardEvent, r: PanelResult, i: number): void => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'ArrowDown') focusItem(i + 1);
    else if (e.key === 'ArrowUp') {
      if (i === 0) input.current?.focus();
      else focusItem(i - 1);
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) act(r, 'newWindow');
    else if (e.key === 'Enter') act(r, 'open');
    else if (e.key === ' ') act(r, 'preview', r.hits[0]?.turnIndex);
    else return;
    e.preventDefault();
  };

  const onQueryKey = (e: KeyboardEvent): void => {
    if (e.key === 'Enter') {
      runNow(query);
      commit(query);
    } else if (e.key === 'ArrowDown' && items.length) {
      e.preventDefault();
      focusItem(0);
    }
  };

  const changeSort = (s: Sort): void => {
    setSort(s);
    runNow(query, s);
  };

  const r = results;
  const sources = [...new Set([...['vscode', 'vscode-insiders', 'copilot-cli'].filter((s) => facets.sources.includes(s)), ...controls.src])];
  const summary = r ? `${r.total.toLocaleString()} session${r.total === 1 ? '' : 's'}${r.totalTurns !== undefined ? ` · ${r.totalTurns.toLocaleString()} turns` : ''} · ${Math.round(r.tookMs)} ms` : '';
  return html`
    <header>
      <div class="query-row">
        <input
          ref=${input}
          class="query"
          type="text"
          list="searchie-history"
          aria-label="Search query"
          placeholder='Search Copilot chats: "phrase", -exclude, pref*, ~fuzzy, ws:, model:, after:30d'
          value=${query}
          onInput=${(e: Event) => onInput((e.target as HTMLInputElement).value)}
          onKeyDown=${onQueryKey}
        />
        <datalist id="searchie-history">${history.map((q) => html`<option value=${q}></option>`)}</datalist>
        <button onClick=${() => (runNow(query), commit(query))}>Search</button>
        <button class="secondary" title="Query syntax" aria-expanded=${help} onClick=${() => setHelp(!help)}>?</button>
      </div>
      ${help
        ? html`<div class="help" role="dialog" aria-label="Query syntax">
            <table>
              ${HELP.map(([s, d]) => html`<tr><td><code>${s}</code></td><td>${d}</td></tr>`)}
            </table>
            <div class="meta">Different filters combine with AND; a repeated filter means OR. The dropdowns edit the filter words in the query.</div>
          </div>`
        : ''}
      <div class="filters">
        ${scope
          ? html`<span class="chip"
              >Scope: ${scope}
              <button class="link" title="Search all sessions" aria-label="Remove scope" onClick=${() => (setScope(undefined), vscode.postMessage({ type: 'clearScope' }), runNow(query))}>✕</button></span
            >`
          : ''}
        <${MultiSelect}
          label="Source"
          options=${sources}
          selected=${controls.src}
          display=${(v: string) => SOURCE_LABELS[v] ?? v}
          onChange=${(v: string[]) => editControl('src', { ...controls, src: v as QueryControls['src'] })}
        />
        <${MultiSelect} label="Workspace" options=${facets.workspaces} selected=${controls.ws} onChange=${(v: string[]) => editControl('ws', { ...controls, ws: v })} />
        <${MultiSelect} label="Model" options=${facets.models} selected=${controls.model} onChange=${(v: string[]) => editControl('model', { ...controls, model: v })} />
        <${MultiSelect} label="Mode" options=${facets.modes} selected=${controls.mode} onChange=${(v: string[]) => editControl('mode', { ...controls, mode: v })} />
        <${DateSelect}
          controls=${controls}
          onChange=${(after: string | undefined, before: string | undefined) => runNow(setControl(setControl(query, 'after', { ...controls, after }), 'before', { ...controls, after, before }))}
        />
      </div>
      <div class="columns" role="group" aria-label="Search in">
        <span class="meta">In:</span>
        ${COLUMNS.map((c: Column) => {
          const checked = controls.in.length === 0 || controls.in.includes(c);
          const toggle = (on: boolean): void => {
            const current = controls.in.length ? controls.in : [...COLUMNS];
            editControl('in', { ...controls, in: on ? [...current, c] : current.filter((x) => x !== c) });
          };
          return html`<label class="option"><input type="checkbox" checked=${checked} onChange=${(e: Event) => toggle((e.target as HTMLInputElement).checked)} /> ${c}</label>`;
        })}
      </div>
    </header>
    <main>
      <div class="summary" aria-live="polite">
        <span>
          ${summary}${busy ? html` <span class="meta">searching…</span>` : ''}
          ${r?.fuzzy ? html` <span class="badge" title="Fewer than 3 sessions matched, so similar words were included">fuzzy results</span>` : ''}
        </span>
        <label class="sort"
          >Sort
          <select value=${sort} onChange=${(e: Event) => changeSort((e.target as HTMLSelectElement).value as Sort)}>
            ${SORT_VALUES.map((s) => html`<option value=${s}>${SORT_LABELS[s]}</option>`)}
          </select>
        </label>
      </div>
      ${r?.suggestion
        ? html`<div class="suggest">
            Did you mean <a href="#" onClick=${(e: Event) => (e.preventDefault(), runNow(r.suggestion!), commit(r.suggestion))}>${r.suggestion}</a>?
          </div>`
        : ''}
      ${r?.warnings.length ? html`<div class="warning">${r.warnings.join(' · ')}</div>` : ''}
      ${error ? html`<div class="warning">${error}</div>` : ''}
      ${r && r.total === 0 && !r.suggestion ? html`<div class="meta empty">No sessions found.</div>` : ''}
      <ol class="results" ref=${list} role="listbox" aria-label="Results">
        ${items.map(
          (x, i) => html`
            <li
              class=${i === active ? 'result active' : 'result'}
              tabindex=${i === active ? 0 : -1}
              role="option"
              aria-selected=${i === active}
              onFocus=${() => setActive(i)}
              onKeyDown=${(e: KeyboardEvent) => onItemKey(e, x, i)}
            >
              <div class="title">${x.source === 'copilot-cli' ? html`<span class="badge">CLI</span> ` : ''}${x.title || UNTITLED}</div>
              <div class="meta">
                ${[x.workspaceName, relativeTime(x.lastActivityAt), shortModel(x.primaryModel), `${x.promptCount} prompts`, x.matchCount > 1 ? `${x.matchCount} matching turns` : undefined]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
              ${x.hits.map(
                (hit) =>
                  html`<a href="#" class="hit" title="Preview at this turn" onClick=${(e: Event) => (e.preventDefault(), act(x, 'preview', hit.turnIndex))}
                    ><span class="turn">#${hit.turnIndex + 1} ${HIT_LABELS[hit.column]}:</span> <${Snippet} text=${hit.snippet}
                  /></a>`,
              )}
              <div class="actions">
                <button onClick=${() => act(x, 'open')}>Open in Chat</button>
                <button class="secondary" onClick=${() => act(x, 'preview', x.hits[0]?.turnIndex)}>Preview</button>
                ${x.source === 'copilot-cli'
                  ? html`<button class="secondary" onClick=${() => act(x, 'copyResume')}>Copy Resume Command</button>`
                  : html`<button class="secondary" onClick=${() => act(x, 'newWindow')}>New Window</button>`}
              </div>
            </li>
          `,
        )}
      </ol>
      ${r && items.length < r.total ? html`<button class="secondary more" onClick=${() => run(applied, sort, items.length)}>Load more (${items.length} of ${r.total})</button>` : ''}
    </main>
  ` as VNode;
}

render(html`<${App} />` as VNode, document.getElementById('app')!);
