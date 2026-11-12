import type { SourceId } from '../core/ids';
import type { FtsColumn } from '../store/schema';
import { type FilterKey, filterOf, tokenize } from './parse';

/**
 * R7.13 – two-way sync between the Search Panel's filter controls and the query text. Text tokens (terms, phrases,
 * operators, invalid filters) are kept verbatim and in order; filter tokens follow in the canonical key order.
 * Pure, so the webview bundle uses it too.
 */

export const FILTER_ORDER: readonly FilterKey[] = ['src', 'ws', 'model', 'mode', 'tool', 'file', 'in', 'after', 'before'];
export type Column = Exclude<FtsColumn, 'aux'>;
export const COLUMNS: readonly Column[] = ['prompt', 'response', 'tools', 'files', 'title'];

export interface QueryControls {
  src: SourceId[];
  ws: string[];
  model: string[];
  mode: string[];
  tool: string[];
  file: string[];
  /** Empty = all columns. */
  in: Column[];
  /** Raw date values (`30d` stays relative). */
  after?: string;
  before?: string;
}

export interface SplitQuery {
  /** Raw text tokens, in order. */
  text: string[];
  /** Raw filter tokens per key, in order. */
  filters: Partial<Record<FilterKey, string[]>>;
  controls: QueryControls;
}

export const emptyControls = (): QueryControls => ({ src: [], ws: [], model: [], mode: [], tool: [], file: [], in: [] });

const addUnique = <T>(list: T[], values: readonly T[]): void => {
  for (const v of values) if (!list.includes(v)) list.push(v);
};

export function splitQuery(query: string, now = Date.now()): SplitQuery {
  const out: SplitQuery = { text: [], filters: {}, controls: emptyControls() };
  const c = out.controls;
  for (const tok of tokenize(query)) {
    const raw = query.slice(tok.start, tok.end);
    const f = filterOf(tok, now);
    if (!f) {
      out.text.push(raw);
      continue;
    }
    (out.filters[f.key] ??= []).push(raw);
    const value = tok.text.slice(tok.text.indexOf(':') + 1).trim();
    switch (f.key) {
      case 'src':
        addUnique(c.src, f.filters.src);
        break;
      case 'in':
        addUnique(c.in, f.filters.columns);
        break;
      case 'after':
      case 'before':
        // The last token of a key wins in the controls; the parser takes the tightest bound of all.
        c[f.key] = value;
        break;
      default:
        addUnique(c[f.key], [value]);
    }
  }
  return out;
}

/** `key:value`, quoted when the value contains whitespace; `"` inside values is dropped. */
function token(key: FilterKey, value: string): string | undefined {
  const v = value.replaceAll('"', '').trim();
  if (!v) return undefined;
  return /\s/.test(v) ? `${key}:"${v}"` : `${key}:${v}`;
}

/** Canonical filter tokens of one control. */
export function controlTokens(key: FilterKey, c: QueryControls): string[] {
  const one = (v: string | undefined): string[] => {
    const t = v === undefined ? undefined : token(key, v);
    return t ? [t] : [];
  };
  switch (key) {
    case 'in': {
      const cols = COLUMNS.filter((col) => c.in.includes(col));
      return cols.length === 0 || cols.length === COLUMNS.length ? [] : [`in:${cols.join(',')}`];
    }
    case 'after':
    case 'before':
      return one(c[key]);
    default:
      return (c[key] as string[]).flatMap((v) => one(v));
  }
}

export function joinQuery(text: readonly string[], filters: SplitQuery['filters']): string {
  return [...text, ...FILTER_ORDER.flatMap((k) => filters[k] ?? [])].join(' ');
}

/** R7.13 – a control edit: all tokens of `key` are replaced by the control's tokens; other tokens keep their text. */
export function setControl(query: string, key: FilterKey, controls: QueryControls, now = Date.now()): string {
  const split = splitQuery(query, now);
  return joinQuery(split.text, { ...split.filters, [key]: controlTokens(key, controls) });
}
