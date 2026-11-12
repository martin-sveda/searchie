import type { SearchResponse } from '../query/engine';
import type { PanelResult, SearchHostToWebview } from '../webview/search-protocol';
import type { QuickPickScope } from './quick-pick';

export interface SearchPanelOptions {
  query?: string;
  scope?: QuickPickScope;
}

/** Pure Search Panel helpers (no vscode dependency). */

export const HISTORY_KEY = 'searchie.queryHistory';
export const HISTORY_MAX = 20;

/** R7.17 – newest first, unique, at most 20, blank queries skipped. */
export function pushHistory(history: readonly string[], query: string): string[] {
  const q = query.trim();
  if (!q) return [...history].slice(0, HISTORY_MAX);
  return [q, ...history.filter((h) => h !== q)].slice(0, HISTORY_MAX);
}

/** Validated-shape DTO: only what the panel shows; ids, paths and URIs stay on the host. */
export function toPanelResults(requestId: number, r: SearchResponse): Extract<SearchHostToWebview, { type: 'results' }> {
  const results: PanelResult[] = r.results.map((x) => ({
    key: x.session.key,
    title: x.session.title,
    workspaceName: x.session.workspaceName,
    source: x.session.source,
    lastActivityAt: x.session.lastActivityAt,
    primaryModel: x.session.primaryModel,
    promptCount: x.session.promptCount,
    credits: x.session.credits,
    matchCount: x.matchCount,
    hits: x.hits.map((h) => ({ turnIndex: h.turnIndex, column: h.column, snippet: h.snippet })),
  }));
  return {
    type: 'results',
    requestId,
    offset: r.offset,
    total: r.total,
    totalTurns: r.totalTurns,
    tookMs: r.tookMs,
    mode: r.mode,
    fuzzy: r.fuzzy,
    suggestion: r.suggestion,
    warnings: r.warnings,
    terms: r.terms,
    results,
  };
}

/** `searchie.openSearchPanel` arguments come from Quick Pick, but any extension can pass anything: validate. */
export function panelOptions(arg: unknown): SearchPanelOptions {
  if (typeof arg !== 'object' || arg === null) return {};
  const o = arg as Record<string, unknown>;
  const query = typeof o.query === 'string' ? o.query.slice(0, 2000) : undefined;
  const s = o.scope as Record<string, unknown> | undefined;
  let scope: QuickPickScope | undefined;
  if (s && typeof s === 'object' && typeof s.label === 'string') {
    const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length <= 4096 ? v : undefined);
    const candidate: QuickPickScope = { label: s.label.slice(0, 200), sessionKey: str(s.sessionKey), workspaceId: str(s.workspaceId), folder: str(s.folder) };
    if (candidate.sessionKey !== undefined || candidate.workspaceId !== undefined || candidate.folder !== undefined) scope = candidate;
  }
  return { query, scope };
}
