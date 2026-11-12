import { SOURCE_IDS, type SourceId } from '../core/ids';
import type { IndexStore, SqlValue } from '../store/index-store';
import { workspaceLabel } from '../ui/tree-model';

/**
 * Statistics (SPEC §9, R9.1): SQL aggregates over `turns` / `sessions` / `turn_tools` only – sessions are never
 * loaded. Hidden turns are excluded; the filter applies per turn; the workspace filter is the folder group (R7.27).
 * Local time comes from SQLite `'localtime'` (the worker's process time zone).
 */

export type Bucket = 'day' | 'week' | 'month';

export interface StatsFilter {
  /** Inclusive lower / exclusive upper bound (ms). */
  after?: number;
  before?: number;
  sources?: string[];
  /** Folder-group ids: `folder:<key>`, or a workspace id for workspaces without a folder. */
  groups?: string[];
  models?: string[];
  modes?: string[];
  /** Activity bucket; `auto` picks day ≤ 60 days, week ≤ 1 year, else month. */
  bucket?: Bucket | 'auto';
}

export interface Kpis {
  sessions: number;
  turns: number;
  prompts: number;
  meaningfulPrompts: number;
  canceled: number;
  toolCalls: number;
  activeDays: number;
  /** null = no turn in the selection recorded it (shown as "—"). */
  promptTokens: number | null;
  completionTokens: number | null;
  credits: number | null;
  /** Share of turns with token / credit data, 0..1 (null without turns). */
  tokenCoverage: number | null;
  creditCoverage: number | null;
  avgPromptsPerSession: number | null;
}

export interface ActivityRow {
  bucket: string;
  source: SourceId;
  prompts: number;
  credits: number | null;
}

export interface GroupRow {
  id: string;
  label: string;
  sessions: number;
  prompts: number;
  credits: number | null;
  lastActivityAt: number;
}

export interface ShareRow {
  /** Empty string = not recorded. */
  name: string;
  turns: number;
  credits: number | null;
}

export interface ToolRow {
  tool: string;
  calls: number;
}

export interface TopSession {
  key: string;
  title: string;
  workspaceName: string;
  source: SourceId;
  prompts: number;
  credits: number | null;
  durationMs: number;
}

export interface StatsResult {
  kpis: Kpis;
  bucket: Bucket;
  activity: ActivityRow[];
  workspaces: GroupRow[];
  models: ShareRow[];
  modes: ShareRow[];
  tools: ToolRow[];
  /** 7 × 24 prompt counts, Monday first, local hours 0–23. */
  heatmap: number[][];
  top: { byPrompts: TopSession[]; byCredits: TopSession[]; byDuration: TopSession[] };
  /** Unfiltered values for the filter bar. */
  facets: { sources: SourceId[]; groups: { id: string; label: string }[]; models: string[]; modes: string[] };
  /** Data range of the selection (ms), for the bucket choice and the date inputs. */
  range: { from: number | null; to: number | null };
  tookMs: number;
}

const DAY = 86_400_000;
const TOP_N = 10;
const TOP_TOOLS = 20;
const GROUP_ID = "COALESCE('folder:' || w.folder, s.workspace_id)";
const FROM = 'FROM turns t JOIN sessions s ON s.key = t.session_key LEFT JOIN workspaces w ON w.id = s.workspace_id';
const LOCAL = "t.ts / 1000, 'unixepoch', 'localtime'";
const BUCKET_SQL: Record<Bucket, string> = {
  day: `date(${LOCAL})`,
  // ISO week, Monday first: move to the week's Sunday ('weekday 0'), then back 6 days.
  week: `date(${LOCAL}, 'weekday 0', '-6 days')`,
  month: `strftime('%Y-%m', ${LOCAL})`,
};

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 500) : []);
const time = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Normalizes a filter from the webview (never trusted): unknown fields dropped, sizes capped. */
export function normalizeFilter(raw: unknown): StatsFilter {
  const o = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const bucket = o.bucket === 'day' || o.bucket === 'week' || o.bucket === 'month' ? o.bucket : 'auto';
  return {
    after: time(o.after),
    before: time(o.before),
    sources: strings(o.sources).filter((s) => (SOURCE_IDS as readonly string[]).includes(s)),
    groups: strings(o.groups),
    models: strings(o.models),
    modes: strings(o.modes),
    bucket,
  };
}

/** Auto bucket per §9.2 from the selected (or data) range. */
export function chooseBucket(from: number | null, to: number | null, requested: StatsFilter['bucket']): Bucket {
  if (requested && requested !== 'auto') return requested;
  if (from === null || to === null) return 'day';
  const days = (to - from) / DAY;
  return days <= 60 ? 'day' : days <= 366 ? 'week' : 'month';
}

function where(f: StatsFilter): { sql: string; params: SqlValue[] } {
  const conds = ['t.hidden = 0'];
  const params: SqlValue[] = [];
  if (f.after !== undefined) {
    conds.push('t.ts >= ?');
    params.push(f.after);
  }
  if (f.before !== undefined) {
    conds.push('t.ts < ?');
    params.push(f.before);
  }
  const inList = (expr: string, values: string[] | undefined): void => {
    if (!values?.length) return;
    conds.push(`${expr} IN (SELECT value FROM json_each(?))`);
    params.push(JSON.stringify(values));
  };
  inList('s.source', f.sources);
  inList(GROUP_ID, f.groups);
  // An empty value selects turns without a recorded model / mode.
  inList("COALESCE(t.model, '')", f.models);
  inList("COALESCE(t.mode, '')", f.modes);
  return { sql: `WHERE ${conds.join(' AND ')}`, params };
}

const ratio = (part: number, whole: number): number | null => (whole > 0 ? part / whole : null);

export class StatsEngine {
  constructor(private readonly store: IndexStore) {}

  compute(rawFilter: StatsFilter = {}): StatsResult {
    const t0 = performance.now();
    const f = normalizeFilter(rawFilter);
    const w = where(f);
    const all = <T>(sql: string, extra: SqlValue[] = []): T[] => this.store.all<T>(sql, [...w.params, ...extra]);

    const k = all<{
      sessions: number;
      turns: number;
      prompts: number | null;
      meaningful: number | null;
      canceled: number | null;
      pin: number | null;
      pout: number | null;
      credits: number | null;
      tokenTurns: number;
      creditTurns: number;
      days: number;
      fromTs: number | null;
      toTs: number | null;
    }>(
      `SELECT count(DISTINCT t.session_key) AS sessions, count(*) AS turns, sum(t.has_prompt) AS prompts,
         sum(t.has_prompt = 1 AND t.noise = 0) AS meaningful, sum(t.canceled) AS canceled,
         sum(t.prompt_tokens) AS pin, sum(t.completion_tokens) AS pout, sum(t.credits) AS credits,
         count(t.prompt_tokens) AS tokenTurns, count(t.credits) AS creditTurns,
         count(DISTINCT date(${LOCAL})) AS days, min(t.ts) AS fromTs, max(t.ts) AS toTs
       ${FROM} ${w.sql}`,
    )[0]!;
    const toolCalls = all<{ n: number | null }>(`SELECT sum(tt.count) AS n FROM turn_tools tt JOIN turns t ON t.id = tt.turn_id JOIN sessions s ON s.key = t.session_key LEFT JOIN workspaces w ON w.id = s.workspace_id ${w.sql}`)[0]?.n ?? 0;
    const prompts = k.prompts ?? 0;
    const kpis: Kpis = {
      sessions: k.sessions,
      turns: k.turns,
      prompts,
      meaningfulPrompts: k.meaningful ?? 0,
      canceled: k.canceled ?? 0,
      toolCalls,
      activeDays: k.days,
      promptTokens: k.pin,
      completionTokens: k.pout,
      credits: k.credits === null ? null : round(k.credits),
      tokenCoverage: ratio(k.tokenTurns, k.turns),
      creditCoverage: ratio(k.creditTurns, k.turns),
      avgPromptsPerSession: ratio(prompts, k.sessions),
    };

    const range = { from: f.after ?? k.fromTs, to: f.before ?? k.toTs };
    const bucket = chooseBucket(range.from, range.to, f.bucket);
    const activity = all<ActivityRow>(
      `SELECT ${BUCKET_SQL[bucket]} AS bucket, s.source AS source, sum(t.has_prompt) AS prompts, sum(t.credits) AS credits
       ${FROM} ${w.sql} GROUP BY bucket, s.source ORDER BY bucket, s.source`,
    ).map((r) => ({ ...r, credits: r.credits === null ? null : round(r.credits) }));

    const labels = this.groupLabels();
    const workspaces = all<{ gid: string; sessions: number; prompts: number; credits: number | null; last: number }>(
      `SELECT ${GROUP_ID} AS gid, count(DISTINCT t.session_key) AS sessions, sum(t.has_prompt) AS prompts, sum(t.credits) AS credits, max(t.ts) AS last
       ${FROM} ${w.sql} GROUP BY gid ORDER BY prompts DESC, last DESC`,
    ).map((r) => ({ id: r.gid, label: labels.get(r.gid) ?? r.gid, sessions: r.sessions, prompts: r.prompts, credits: r.credits === null ? null : round(r.credits), lastActivityAt: r.last }));

    const share = (col: 'model' | 'mode'): ShareRow[] =>
      // Aliases must not shadow joined columns (`w.name`, `t.id`): SQLite resolves GROUP BY names to columns first.
      all<{ k: string; n: number; credits: number | null }>(
        `SELECT COALESCE(t.${col}, '') AS k, count(*) AS n, sum(t.credits) AS credits ${FROM} ${w.sql} GROUP BY k ORDER BY n DESC, k`,
      ).map((r) => ({ name: r.k, turns: r.n, credits: r.credits === null ? null : round(r.credits) }));

    const tools = all<ToolRow>(
      `SELECT tt.tool AS tool, sum(tt.count) AS calls FROM turn_tools tt JOIN turns t ON t.id = tt.turn_id JOIN sessions s ON s.key = t.session_key
       LEFT JOIN workspaces w ON w.id = s.workspace_id ${w.sql} GROUP BY tt.tool ORDER BY calls DESC, tt.tool LIMIT ?`,
      [TOP_TOOLS],
    );

    const heatmap = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
    for (const r of all<{ dow: number; hour: number; prompts: number }>(
      `SELECT CAST(strftime('%w', ${LOCAL}) AS INTEGER) AS dow, CAST(strftime('%H', ${LOCAL}) AS INTEGER) AS hour, sum(t.has_prompt) AS prompts
       ${FROM} ${w.sql} GROUP BY dow, hour`,
    )) {
      heatmap[(r.dow + 6) % 7]![r.hour] = r.prompts;
    }

    const perSession = all<{ key: string; prompts: number; credits: number | null; duration: number }>(
      `SELECT t.session_key AS key, sum(t.has_prompt) AS prompts, sum(t.credits) AS credits,
         max(t.ts + COALESCE(t.elapsed_ms, 0)) - min(t.ts) AS duration
       ${FROM} ${w.sql} GROUP BY t.session_key`,
    );
    const top = this.topSessions(perSession, labels);

    return { kpis, bucket, activity, workspaces, models: share('model'), modes: share('mode'), tools, heatmap, top, facets: this.facets(labels), range, tookMs: performance.now() - t0 };
  }

  /** R7.27 group labels: VS Code workspace name if present, else the CLI label, followed by the sources. */
  private groupLabels(): Map<string, string> {
    const rows = this.store.all<{ id: string; source: SourceId; name: string | null }>(`SELECT COALESCE('folder:' || folder, id) AS id, source, name FROM workspaces w ORDER BY id`);
    const groups = new Map<string, { sources: Set<SourceId>; vscode?: string; cli?: string }>();
    for (const r of rows) {
      const g = groups.get(r.id) ?? { sources: new Set<SourceId>() };
      g.sources.add(r.source);
      if (r.source === 'copilot-cli') g.cli ??= r.name ?? undefined;
      else g.vscode ??= r.name ?? undefined;
      groups.set(r.id, g);
    }
    return new Map([...groups].map(([id, g]) => [id, workspaceLabel(g.vscode ?? g.cli ?? id, g.sources)]));
  }

  private topSessions(perSession: { key: string; prompts: number; credits: number | null; duration: number }[], labels: Map<string, string>): StatsResult['top'] {
    const pick = (cmp: (a: (typeof perSession)[number], b: (typeof perSession)[number]) => number, keep: (r: (typeof perSession)[number]) => boolean = () => true): typeof perSession =>
      perSession.filter(keep).sort((a, b) => cmp(a, b) || (a.key < b.key ? -1 : 1)).slice(0, TOP_N);
    const byPrompts = pick((a, b) => b.prompts - a.prompts);
    const byCredits = pick((a, b) => (b.credits ?? 0) - (a.credits ?? 0), (r) => r.credits !== null && r.credits > 0);
    const byDuration = pick((a, b) => b.duration - a.duration);
    const keys = [...new Set([...byPrompts, ...byCredits, ...byDuration].map((r) => r.key))];
    const meta = new Map(
      this.store
        .all<{ key: string; title: string; source: SourceId; gid: string; name: string | null }>(
          `SELECT s.key, s.title, s.source, ${GROUP_ID} AS gid, w.name FROM sessions s LEFT JOIN workspaces w ON w.id = s.workspace_id WHERE s.key IN (SELECT value FROM json_each(?))`,
          [JSON.stringify(keys)],
        )
        .map((r) => [r.key, r]),
    );
    const toTop = (r: (typeof perSession)[number]): TopSession => {
      const m = meta.get(r.key);
      return {
        key: r.key,
        title: m?.title ?? '',
        workspaceName: m ? (labels.get(m.gid) ?? m.name ?? '') : '',
        source: m?.source ?? 'vscode',
        prompts: r.prompts,
        credits: r.credits === null ? null : round(r.credits),
        durationMs: r.duration,
      };
    };
    return { byPrompts: byPrompts.map(toTop), byCredits: byCredits.map(toTop), byDuration: byDuration.map(toTop) };
  }

  private facets(labels: Map<string, string>): StatsResult['facets'] {
    const col = (sql: string): string[] => this.store.all<{ v: string }>(sql).map((r) => r.v);
    const sources = col('SELECT DISTINCT s.source AS v FROM sessions s WHERE s.turn_count > 0 ORDER BY v') as SourceId[];
    const groups = col(`SELECT DISTINCT ${GROUP_ID} AS v FROM sessions s LEFT JOIN workspaces w ON w.id = s.workspace_id WHERE s.turn_count > 0`)
      .map((id) => ({ id, label: labels.get(id) ?? id }))
      .sort((a, b) => a.label.localeCompare(b.label));
    return {
      sources,
      groups,
      models: col("SELECT DISTINCT COALESCE(model, '') AS v FROM turns WHERE hidden = 0 ORDER BY v"),
      modes: col("SELECT DISTINCT COALESCE(mode, '') AS v FROM turns WHERE hidden = 0 ORDER BY v"),
    };
  }
}

/** Credits are fractional (CLI nano-AIU); 6 decimals avoid float noise in sums. */
function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
