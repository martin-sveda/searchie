import { type ListRow, SESSION_LIST_SQL, type SessionListItem, toListItem } from '../store/index-db';
import type { IndexStore, SqlValue } from '../store/index-store';
import type { FtsColumn } from '../store/schema';
import { buildFilters, buildMatch, buildNegativeMatch, type Scope, type SqlFilter } from './fts';
import { highlightTerms, parseQuery } from './parse';
import {
  DEFAULT_PAGE,
  DEFAULT_RECENCY_BOOST,
  mergeWeights,
  NOISE_FACTOR,
  RECENCY_DAYS,
  SNIPPET_TOKENS,
  sessionScore,
  TURNS_PER_SESSION,
  turnScore,
  type Weights,
} from './ranking';
import { cleanSnippet, hasMark } from './snippet';

/** Query engine (§6.3, §6.4): ranked, session-grouped, paged search with redacted snippets. */

export interface SearchRequest {
  query: string;
  limit?: number;
  offset?: number;
  scope?: Scope;
  recencyBoost?: number;
  weights?: Partial<Record<string, unknown>>;
  redact?: boolean;
  now?: number;
}

export interface SearchHit {
  turnIndex: number;
  timestamp: number;
  column: Exclude<FtsColumn, 'aux'>;
  snippet: string;
  score: number;
}

export interface SearchResult {
  session: SessionListItem;
  score: number;
  matchCount: number;
  hits: SearchHit[];
}

export interface SearchResponse {
  results: SearchResult[];
  total: number;
  offset: number;
  tookMs: number;
  terms: string[];
  warnings: string[];
  /** 'text' = ranked FTS; 'list' = filters only / empty query, ordered by last activity (R6.4). */
  mode: 'text' | 'list';
}

/** Snippet columns in display priority; `aux` is never shown (R5.7). */
const SNIPPET_COLUMNS: [Exclude<FtsColumn, 'aux'>, number][] = [
  ['prompt', 1],
  ['response', 2],
  ['tools', 3],
  ['files', 4],
  ['title', 0],
];

const BM25 = 'bm25(turn_fts, ?, ?, ?, ?, ?, ?)';
const weightParams = (w: Weights): number[] => [w.title, w.prompt, w.response, w.tools, w.files, w.aux];

const where = (conds: string[]): string => (conds.length ? ` AND ${conds.join(' AND ')}` : '');

export class QueryEngine {
  private mathFunctions: boolean | undefined;

  constructor(private readonly store: IndexStore) {}

  /** SQLite math functions (exp/ln) are compile-time options; fall back to scoring in JS without them. */
  hasMathFunctions(): boolean {
    if (this.mathFunctions === undefined) {
      try {
        this.store.get('SELECT exp(0) AS e, ln(1) AS l');
        this.mathFunctions = true;
      } catch {
        this.mathFunctions = false;
      }
    }
    return this.mathFunctions;
  }

  /** Test hook: force the JS scoring path. */
  setMathFunctions(available: boolean): void {
    this.mathFunctions = available;
  }

  search(req: SearchRequest): SearchResponse {
    const t0 = performance.now();
    const now = req.now ?? Date.now();
    const ast = parseQuery(req.query, now);
    const limit = Math.max(1, Math.min(500, req.limit ?? DEFAULT_PAGE));
    const offset = Math.max(0, req.offset ?? 0);
    const filters = buildFilters(ast.filters, req.scope);
    const match = buildMatch(ast);
    const base = { offset, terms: highlightTerms(ast), warnings: ast.warnings };
    if (!match) {
      const { results, total } = this.list(filters, buildNegativeMatch(ast), limit, offset);
      return { ...base, results, total, tookMs: performance.now() - t0, mode: 'list' };
    }
    const weights = mergeWeights(req.weights);
    const beta = req.recencyBoost ?? DEFAULT_RECENCY_BOOST;
    let ranked: { sk: string; best: number; k: number; score: number }[];
    let total: number;
    try {
      ({ ranked, total } = this.hasMathFunctions() ? this.rankSql(match, filters, weights, beta, now, limit, offset) : this.rankJs(match, filters, weights, beta, now, limit, offset));
    } catch (e) {
      // A malformed FTS expression can only come from a bug; never surface SQL errors as results.
      return { ...base, results: [], total: 0, tookMs: performance.now() - t0, mode: 'text', warnings: [...ast.warnings, `search failed (${(e as Error).name})`] };
    }
    const results = this.hydrate(ranked, match, filters, weights, beta, now, req.redact !== false);
    return { ...base, results, total, tookMs: performance.now() - t0, mode: 'text' };
  }

  /** Score expression; bind `weightParams(weights)`, then beta and now. */
  private scoreSql(): string {
    return `(-${BM25} * (1 + ? * exp(-(? - t.ts) / ${RECENCY_DAYS * 86_400_000}.0)) * (CASE t.noise WHEN 1 THEN ${NOISE_FACTOR} ELSE 1.0 END))`;
  }

  private matchFrom(filters: SqlFilter): { sql: string; params: SqlValue[] } {
    return {
      sql: `FROM turn_fts JOIN turns t ON t.id = turn_fts.rowid JOIN sessions s ON s.key = t.session_key
        WHERE turn_fts MATCH ? AND t.hidden = 0${where(filters.session)}${where(filters.turn)}`,
      params: [...filters.sessionParams, ...filters.turnParams],
    };
  }

  private rankSql(match: string, filters: SqlFilter, weights: Weights, beta: number, now: number, limit: number, offset: number): { ranked: { sk: string; best: number; k: number; score: number }[]; total: number } {
    const from = this.matchFrom(filters);
    // FTS5 refuses bm25() inside aggregates, so scores are materialized first (spike S2).
    const rows = this.store.all<{ sk: string; best: number; k: number; score: number; total: number }>(
      `WITH m AS MATERIALIZED (SELECT t.session_key AS sk, ${this.scoreSql()} AS sc ${from.sql})
       SELECT sk, max(sc) AS best, count(*) AS k, max(sc) + 0.25 * ln(count(*)) AS score, count(*) OVER () AS total
       FROM m GROUP BY sk ORDER BY score DESC, sk LIMIT ? OFFSET ?`,
      [...weightParams(weights), beta, now, match, ...from.params, limit, offset],
    );
    const total = rows[0]?.total ?? (offset > 0 ? this.countSessions(match, filters) : 0);
    return { ranked: rows, total };
  }

  private countSessions(match: string, filters: SqlFilter): number {
    const from = this.matchFrom(filters);
    return this.store.get<{ n: number }>(`SELECT count(DISTINCT t.session_key) AS n ${from.sql}`, [match, ...from.params])?.n ?? 0;
  }

  private rankJs(match: string, filters: SqlFilter, weights: Weights, beta: number, now: number, limit: number, offset: number): { ranked: { sk: string; best: number; k: number; score: number }[]; total: number } {
    const from = this.matchFrom(filters);
    const rows = this.store.all<{ sk: string; b: number; ts: number; noise: number }>(
      `SELECT t.session_key AS sk, ${BM25} AS b, t.ts, t.noise ${from.sql}`,
      [...weightParams(weights), match, ...from.params],
    );
    const agg = new Map<string, { best: number; k: number }>();
    for (const r of rows) {
      const s = turnScore(r.b, r.ts, r.noise === 1, now, beta);
      const a = agg.get(r.sk);
      if (!a) agg.set(r.sk, { best: s, k: 1 });
      else {
        a.best = Math.max(a.best, s);
        a.k++;
      }
    }
    const all = [...agg].map(([sk, a]) => ({ sk, best: a.best, k: a.k, score: sessionScore(a.best, a.k) }));
    all.sort((a, b) => b.score - a.score || (a.sk < b.sk ? -1 : 1));
    return { ranked: all.slice(offset, offset + limit), total: all.length };
  }

  private hydrate(
    ranked: { sk: string; best: number; k: number; score: number }[],
    match: string,
    filters: SqlFilter,
    weights: Weights,
    beta: number,
    now: number,
    redact: boolean,
  ): SearchResult[] {
    if (!ranked.length) return [];
    const keys = JSON.stringify(ranked.map((r) => r.sk));
    const sessions = new Map(
      this.store.all<ListRow>(`${SESSION_LIST_SQL} WHERE s.key IN (SELECT value FROM json_each(?))`, [keys]).map((r) => [r.key, toListItem(r)]),
    );
    const from = this.matchFrom(filters);
    const turnRows = this.store.all<{ sk: string; tid: number; idx: number; ts: number; b: number; noise: number }>(
      `SELECT t.session_key AS sk, t.id AS tid, t.idx, t.ts, t.noise,
         ${BM25} AS b
       ${from.sql} AND t.session_key IN (SELECT value FROM json_each(?))`,
      [...weightParams(weights), match, ...from.params, keys],
    );
    const bySession = new Map<string, { tid: number; idx: number; ts: number; score: number }[]>();
    for (const r of turnRows) {
      const list = bySession.get(r.sk) ?? [];
      list.push({ tid: r.tid, idx: r.idx, ts: r.ts, score: turnScore(r.b, r.ts, r.noise === 1, now, beta) });
      bySession.set(r.sk, list);
    }
    const top = new Map<number, { idx: number; ts: number; score: number }>();
    for (const list of bySession.values()) {
      list.sort((a, b) => b.score - a.score || a.idx - b.idx);
      for (const t of list.slice(0, TURNS_PER_SESSION)) top.set(t.tid, t);
    }
    const snippetSql = SNIPPET_COLUMNS.map(([name, col]) => `snippet(turn_fts, ${col}, char(1), char(2), '…', ${SNIPPET_TOKENS}) AS ${name}`).join(', ');
    const snippets = new Map(
      this.store
        .all<Record<string, string> & { rowid: number }>(`SELECT rowid, ${snippetSql} FROM turn_fts WHERE turn_fts MATCH ? AND rowid IN (SELECT value FROM json_each(?))`, [
          match,
          JSON.stringify([...top.keys()]),
        ])
        .map((r) => [r.rowid, r]),
    );
    const results: SearchResult[] = [];
    for (const r of ranked) {
      const session = sessions.get(r.sk);
      if (!session) continue;
      const hits: SearchHit[] = [];
      for (const t of (bySession.get(r.sk) ?? []).slice(0, TURNS_PER_SESSION)) {
        const sn = snippets.get(t.tid);
        const [column, text] = pickSnippet(sn);
        hits.push({ turnIndex: t.idx, timestamp: t.ts, column, snippet: cleanSnippet(text, redact), score: t.score });
      }
      results.push({ session, score: r.score, matchCount: r.k, hits });
    }
    return results;
  }

  /** R6.4 – filters only (or empty / negative-only query): sessions by last activity. */
  private list(filters: SqlFilter, negative: string | null, limit: number, offset: number): { results: SearchResult[]; total: number } {
    const conds = ['s.turn_count > 0', ...filters.session];
    const params: SqlValue[] = [...filters.sessionParams];
    if (filters.turn.length) {
      conds.push(`EXISTS (SELECT 1 FROM turns t WHERE t.session_key = s.key AND t.hidden = 0${where(filters.turn)})`);
      params.push(...filters.turnParams);
    }
    if (negative) {
      conds.push('s.key NOT IN (SELECT t.session_key FROM turn_fts JOIN turns t ON t.id = turn_fts.rowid WHERE turn_fts MATCH ? AND t.hidden = 0)');
      params.push(negative);
    }
    const rows = this.store.all<ListRow & { total: number }>(
      `SELECT x.*, count(*) OVER () AS total FROM (${SESSION_LIST_SQL} WHERE ${conds.join(' AND ')}) x ORDER BY x.lastActivityAt DESC, x.key LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    return { results: rows.map((r) => ({ session: toListItem(r), score: 0, matchCount: 0, hits: [] })), total: rows[0]?.total ?? 0 };
  }
}

function pickSnippet(row: Record<string, string> | undefined): [Exclude<FtsColumn, 'aux'>, string] {
  if (!row) return ['prompt', ''];
  for (const [name] of SNIPPET_COLUMNS) {
    const v = row[name];
    if (v && hasMark(v)) return [name, v];
  }
  // Matched only in the hidden aux column: show the start of the prompt (or response).
  return row.prompt ? ['prompt', row.prompt] : ['response', row.response ?? ''];
}
