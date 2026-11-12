import { redactSecrets } from '../core/vendor/redact-secrets';
import type { StatsResult } from '../query/stats';
import type { StatsTable } from '../webview/stats-protocol';

/**
 * R9.3 – CSV for each statistics widget: UTF-8 with BOM, CRLF, RFC 4180 quoting, raw numbers, local ISO 8601
 * timestamps with offset, empty cells for missing values, redacted text, and formula-injection protection.
 */

type Cell = string | number | null | undefined;
const FORMULA_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** One CSV cell. Numbers are written raw; text is redacted first, then protected, then quoted. */
export function csvCell(value: Cell, redact: boolean): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  let text = redact ? redactSecrets(value) : value;
  // A spreadsheet would evaluate a cell starting with these characters as a formula.
  if (FORMULA_START.test(text)) text = `'${text}`;
  return NEEDS_QUOTES.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Local ISO 8601 with offset, e.g. `2026-01-15T12:00:00.000+01:00`. */
export function localIso(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number, w = 2): string => String(Math.abs(n)).padStart(w, '0');
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`;
}

/** `searchie-<table>-<YYYY-MM-DD>.csv` in local time. */
export function csvFileName(table: StatsTable, now = Date.now()): string {
  return `searchie-${table}-${localIso(now).slice(0, 10)}.csv`;
}

function rowsFor(r: StatsResult, table: StatsTable): Cell[][] {
  switch (table) {
    case 'kpis': {
      const k = r.kpis;
      return [
        ['metric', 'value'],
        ['sessions', k.sessions],
        ['turns', k.turns],
        ['prompts', k.prompts],
        ['meaningful_prompts', k.meaningfulPrompts],
        ['canceled', k.canceled],
        ['tool_calls', k.toolCalls],
        ['active_days', k.activeDays],
        ['avg_prompts_per_session', k.avgPromptsPerSession],
        ['prompt_tokens', k.promptTokens],
        ['completion_tokens', k.completionTokens],
        ['token_coverage', k.tokenCoverage],
        ['credits', k.credits],
        ['credit_coverage', k.creditCoverage],
      ];
    }
    case 'activity':
      return [['period', 'source', 'prompts', 'credits'], ...r.activity.map((a) => [a.bucket, a.source, a.prompts, a.credits])];
    case 'workspaces':
      return [['workspace', 'sessions', 'prompts', 'credits', 'last_activity'], ...r.workspaces.map((w) => [w.label, w.sessions, w.prompts, w.credits, localIso(w.lastActivityAt)])];
    case 'models':
      return [['model', 'turns', 'credits'], ...r.models.map((m) => [m.name, m.turns, m.credits])];
    case 'modes':
      return [['mode', 'turns', 'credits'], ...r.modes.map((m) => [m.name, m.turns, m.credits])];
    case 'tools':
      return [['tool', 'calls'], ...r.tools.map((t) => [t.tool, t.calls])];
    case 'heatmap':
      return [['weekday', ...Array.from({ length: 24 }, (_, h) => `h${h}`)], ...r.heatmap.map((row, d) => [WEEKDAYS[d], ...row])];
    case 'top': {
      const rows: Cell[][] = [['ranking', 'rank', 'title', 'workspace', 'source', 'prompts', 'credits', 'duration_ms']];
      for (const [ranking, list] of [
        ['prompts', r.top.byPrompts],
        ['credits', r.top.byCredits],
        ['duration', r.top.byDuration],
      ] as const) {
        list.forEach((s, i) => rows.push([ranking, i + 1, s.title, s.workspaceName, s.source, s.prompts, s.credits, s.durationMs]));
      }
      return rows;
    }
  }
}

/** The whole file: BOM + CRLF-separated records. */
export function statsCsv(r: StatsResult, table: StatsTable, redact: boolean): { text: string; rows: number } {
  const rows = rowsFor(r, table);
  return { text: `\uFEFF${rows.map((row) => row.map((c) => csvCell(c, redact)).join(',')).join('\r\n')}\r\n`, rows: rows.length - 1 };
}
