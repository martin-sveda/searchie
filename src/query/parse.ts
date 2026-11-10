import type { SourceId } from '../core/model';
import type { FtsColumn } from '../store/schema';

/** Hand-written parser for the §6.1 query syntax (R6.1, R6.2). Never throws: bad parts degrade to plain terms. */

export type Term = { kind: 'term'; text: string; prefix: boolean; fuzzy: boolean } | { kind: 'phrase'; text: string };

/** A clause is one term or an OR group of terms; negated clauses exclude. */
export interface Clause {
  negated: boolean;
  alternatives: Term[];
}

export interface Filters {
  ws: string[];
  src: SourceId[];
  model: string[];
  mode: string[];
  tool: string[];
  file: string[];
  columns: Exclude<FtsColumn, 'aux'>[];
  after?: number;
  before?: number;
}

export interface QueryAst {
  clauses: Clause[];
  filters: Filters;
  warnings: string[];
}

interface Token {
  text: string;
  quoted: boolean;
  /** The whole token was one quoted string (a phrase). */
  fullyQuoted: boolean;
}

const FILTER_KEYS = new Set(['ws', 'src', 'source', 'model', 'mode', 'tool', 'file', 'in', 'after', 'before']);
const COLUMN_ALIASES: Record<string, Exclude<FtsColumn, 'aux'>> = {
  title: 'title',
  prompt: 'prompt',
  prompts: 'prompt',
  user: 'prompt',
  you: 'prompt',
  response: 'response',
  responses: 'response',
  answer: 'response',
  copilot: 'response',
  tools: 'tools',
  tool: 'tools',
  files: 'files',
  file: 'files',
};
const SOURCE_ALIASES: Record<string, SourceId> = {
  vscode: 'vscode',
  code: 'vscode',
  stable: 'vscode',
  insiders: 'vscode-insiders',
  'vscode-insiders': 'vscode-insiders',
  cli: 'copilot-cli',
  'copilot-cli': 'copilot-cli',
};
const HAS_WORD = /[\p{L}\p{N}_]/u;
const MAX_QUERY_CHARS = 2000;
const MAX_CLAUSES = 32;

export function emptyFilters(): Filters {
  return { ws: [], src: [], model: [], mode: [], tool: [], file: [], columns: [] };
}

/** Splits into whitespace-separated tokens; `"…"` segments may contain spaces (unterminated quotes run to the end). */
export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  const s = input.slice(0, MAX_QUERY_CHARS);
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i]!)) i++;
    if (i >= s.length) break;
    let text = '';
    let quoted = false;
    let segments = 0;
    let quotedSegments = 0;
    while (i < s.length && !/\s/.test(s[i]!)) {
      if (s[i] === '"') {
        const end = s.indexOf('"', i + 1);
        const stop = end < 0 ? s.length : end;
        text += s.slice(i + 1, stop);
        i = end < 0 ? s.length : end + 1;
        quoted = true;
        quotedSegments++;
      } else {
        let j = i;
        while (j < s.length && !/\s/.test(s[j]!) && s[j] !== '"') j++;
        text += s.slice(i, j);
        i = j;
      }
      segments++;
    }
    tokens.push({ text, quoted, fullyQuoted: quoted && segments === 1 && quotedSegments === 1 });
  }
  return tokens;
}

const DAY = 86_400_000;

/** `YYYY-MM-DD` (local midnight), or relative `7d`, `2w`, `3m`, `1y` before `now`. */
export function parseDate(value: string, now: number): number | undefined {
  const abs = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value);
  if (abs) {
    const d = new Date(Number(abs[1]), Number(abs[2]) - 1, Number(abs[3]));
    return d.getMonth() === Number(abs[2]) - 1 ? d.getTime() : undefined;
  }
  const rel = /^(\d{1,4})([dwmy])$/i.exec(value);
  if (!rel) return undefined;
  const n = Number(rel[1]);
  const unit = rel[2]!.toLowerCase();
  if (unit === 'd') return now - n * DAY;
  if (unit === 'w') return now - n * 7 * DAY;
  const d = new Date(now);
  if (unit === 'm') d.setMonth(d.getMonth() - n);
  else d.setFullYear(d.getFullYear() - n);
  return d.getTime();
}

function applyFilter(key: string, value: string, f: Filters, now: number, warnings: string[]): boolean {
  switch (key) {
    case 'ws':
    case 'model':
    case 'mode':
    case 'tool':
    case 'file':
      f[key].push(value);
      return true;
    case 'src':
    case 'source': {
      const src = SOURCE_ALIASES[value.toLowerCase()];
      if (!src) {
        warnings.push(`unknown source "${value}"`);
        return false;
      }
      if (!f.src.includes(src)) f.src.push(src);
      return true;
    }
    case 'in': {
      const cols = value.split(',').map((c) => COLUMN_ALIASES[c.trim().toLowerCase()]);
      if (cols.some((c) => c === undefined)) {
        warnings.push(`unknown column in "in:${value}"`);
        return false;
      }
      for (const c of cols) if (c && !f.columns.includes(c)) f.columns.push(c);
      return true;
    }
    case 'after':
    case 'before': {
      const t = parseDate(value, now);
      if (t === undefined) {
        warnings.push(`invalid date "${value}"`);
        return false;
      }
      if (key === 'after') f.after = Math.max(f.after ?? Number.NEGATIVE_INFINITY, t);
      else f.before = Math.min(f.before ?? Number.POSITIVE_INFINITY, t);
      return true;
    }
    default:
      return false;
  }
}

function toTerm(tok: Token, text: string, fuzzy: boolean): Term | undefined {
  if (!HAS_WORD.test(text)) return undefined;
  if (tok.fullyQuoted) return { kind: 'phrase', text };
  const stars = /\*+$/.exec(text);
  const bare = stars ? text.slice(0, stars.index) : text;
  if (!HAS_WORD.test(bare)) return undefined;
  // Prefix only for ≥ 2 characters (prefix index '2 3'); shorter prefixes are plain terms (S2 worst-case queries).
  const prefix = stars !== null && !tok.quoted && [...bare].length >= 2;
  return { kind: 'term', text: bare, prefix, fuzzy };
}

export function parseQuery(input: string, now = Date.now()): QueryAst {
  const filters = emptyFilters();
  const warnings: string[] = [];
  const items: ({ op: 'or' } | { op: 'term'; negated: boolean; term: Term })[] = [];
  for (const tok of tokenize(input)) {
    let text = tok.text;
    if (!tok.quoted && text === 'OR') {
      items.push({ op: 'or' });
      continue;
    }
    let negated = false;
    let fuzzy = false;
    if (text.length > 1 && text.startsWith('-') && (tok.quoted || HAS_WORD.test(text.slice(1)))) {
      negated = true;
      text = text.slice(1);
    }
    if (text.length > 1 && text.startsWith('~')) {
      fuzzy = true; // Phase 2: fuzzy expansion (R6.5). Phase 1 treats ~term as a plain term.
      text = text.slice(1);
    }
    const filter = /^([a-z]+):(.+)$/is.exec(text);
    if (!negated && !fuzzy && filter && FILTER_KEYS.has(filter[1]!.toLowerCase()) && !tok.fullyQuoted) {
      if (applyFilter(filter[1]!.toLowerCase(), filter[2]!.trim(), filters, now, warnings)) continue;
    }
    const term = toTerm(tok, text, fuzzy);
    if (term) items.push({ op: 'term', negated, term });
  }

  const clauses: Clause[] = [];
  let pendingOr = false;
  for (const item of items) {
    if (item.op === 'or') {
      pendingOr = true;
      continue;
    }
    const last = clauses[clauses.length - 1];
    if (pendingOr && last && !last.negated && !item.negated) last.alternatives.push(item.term);
    else clauses.push({ negated: item.negated, alternatives: [item.term] });
    pendingOr = false;
  }
  if (clauses.length > MAX_CLAUSES) {
    warnings.push(`only the first ${MAX_CLAUSES} terms are used`);
    clauses.length = MAX_CLAUSES;
  }
  return { clauses, filters, warnings };
}

/** Lower-cased positive term texts, for highlighting in Preview (R7.23). */
export function highlightTerms(ast: QueryAst): string[] {
  const out = new Set<string>();
  for (const c of ast.clauses) if (!c.negated) for (const t of c.alternatives) out.add(t.text.toLowerCase());
  return [...out];
}
