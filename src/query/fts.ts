import type { SqlValue } from '../store/index-store';
import type { Clause, Filters, QueryAst, Term } from './parse';

/** AST → FTS5 MATCH expression and SQL filters (R6.1, R6.3). Every term is emitted quoted; values are bound. */

/** FTS5 string literal: double quotes, inner quotes doubled. Nothing user-typed is ever emitted unquoted. */
export function ftsQuote(text: string): string {
  return `"${text.replaceAll('"', '""')}"`;
}

function termExpr(t: Term): string {
  return t.kind === 'term' && t.prefix ? `${ftsQuote(t.text)}*` : ftsQuote(t.text);
}

function clauseExpr(c: Clause): string {
  const parts = c.alternatives.map(termExpr);
  return parts.length === 1 ? parts[0]! : `(${parts.join(' OR ')})`;
}

/** FTS5 expression for the positive clauses, with negatives as `NOT`; null when there is no positive clause. */
export function buildMatch(ast: QueryAst): string | null {
  const positive = ast.clauses.filter((c) => !c.negated);
  if (positive.length === 0) return null;
  let expr = positive.map(clauseExpr).join(' AND ');
  const negative = ast.clauses.filter((c) => c.negated);
  if (negative.length) expr = `(${expr}) NOT (${negative.map(clauseExpr).join(' OR ')})`;
  if (ast.filters.columns.length) expr = `{${ast.filters.columns.join(' ')}} : (${expr})`;
  return expr;
}

/** Negative-only queries (`-azure`): the expression whose matching sessions are excluded. */
export function buildNegativeMatch(ast: QueryAst): string | null {
  if (ast.clauses.some((c) => !c.negated)) return null;
  const negative = ast.clauses.filter((c) => c.negated);
  if (!negative.length) return null;
  const expr = negative.map(clauseExpr).join(' OR ');
  return ast.filters.columns.length ? `{${ast.filters.columns.join(' ')}} : (${expr})` : expr;
}

export function likeContains(value: string): string {
  return `%${value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
}

export interface SqlFilter {
  /** Conditions over `s` (sessions). */
  session: string[];
  /** Conditions over `t` (turns). */
  turn: string[];
  sessionParams: SqlValue[];
  turnParams: SqlValue[];
}

export interface Scope {
  sessionKey?: string;
  workspaceId?: string;
  /** A folder group (R7.27): every workspace with this folder key. */
  folder?: string;
}

function anyOf(column: string, values: readonly string[], params: SqlValue[]): string {
  for (const v of values) params.push(likeContains(v));
  return `(${values.map(() => `${column} LIKE ? ESCAPE '\\'`).join(' OR ')})`;
}

export function buildFilters(f: Filters, scope: Scope = {}): SqlFilter {
  const out: SqlFilter = { session: [], turn: [], sessionParams: [], turnParams: [] };
  if (scope.sessionKey) {
    out.session.push('s.key = ?');
    out.sessionParams.push(scope.sessionKey);
  }
  if (scope.workspaceId) {
    out.session.push('s.workspace_id = ?');
    out.sessionParams.push(scope.workspaceId);
  }
  if (scope.folder !== undefined) {
    out.session.push('s.workspace_id IN (SELECT id FROM workspaces WHERE folder = ?)');
    out.sessionParams.push(scope.folder);
  }
  if (f.ws.length) {
    const params: SqlValue[] = [];
    out.session.push(`s.workspace_id IN (SELECT id FROM workspaces WHERE ${anyOf('name', f.ws, params)})`);
    out.sessionParams.push(...params);
  }
  if (f.src.length) {
    out.session.push(`s.source IN (${f.src.map(() => '?').join(', ')})`);
    out.sessionParams.push(...f.src);
  }
  if (f.model.length) out.turn.push(anyOf('t.model', f.model, out.turnParams));
  if (f.mode.length) out.turn.push(anyOf('t.mode', f.mode, out.turnParams));
  if (f.tool.length) {
    const params: SqlValue[] = [];
    out.turn.push(`EXISTS (SELECT 1 FROM turn_tools tt WHERE tt.turn_id = t.id AND ${anyOf('tt.tool', f.tool, params)})`);
    out.turnParams.push(...params);
  }
  if (f.file.length) {
    const params: SqlValue[] = [];
    out.turn.push(`EXISTS (SELECT 1 FROM turn_text x WHERE x.id = t.id AND ${anyOf('x.files', f.file, params)})`);
    out.turnParams.push(...params);
  }
  if (f.after !== undefined) {
    out.turn.push('t.ts >= ?');
    out.turnParams.push(f.after);
  }
  if (f.before !== undefined) {
    out.turn.push('t.ts < ?');
    out.turnParams.push(f.before);
  }
  return out;
}

export const hasFilters = (f: Filters): boolean =>
  f.ws.length + f.src.length + f.model.length + f.mode.length + f.tool.length + f.file.length > 0 || f.after !== undefined || f.before !== undefined;
