import type { IndexStore } from '../store/index-store';
import type { QueryAst, Term } from './parse';

/** Fuzzy term expansion and "Did you mean" candidates from the FTS vocabulary (SPEC R6.5–R6.7). */

export const MIN_FUZZY_CHARS = 3;
export const MAX_EXPANSIONS = 10;
const MAX_LENGTH_DELTA = 2;
/** Terms the unicode61 tokenizer keeps as one token (tokenchars '_'); others can't be looked up in the vocabulary. */
const SINGLE_TOKEN = /^[\p{L}\p{N}_]+$/u;

/** Folds like the tokenizer: lower case, diacritics removed (`remove_diacritics 2`). */
export function foldTerm(text: string): string {
  return text.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
}

/** R6.5 – at most 1 edit below 5 characters, else 2. */
export const maxDistance = (length: number): number => (length < 5 ? 1 : 2);

/**
 * Damerau–Levenshtein distance (optimal string alignment: insert, delete, substitute, swap adjacent) over code
 * points, capped: any distance above `max` is returned as `max + 1`.
 */
export function damerauLevenshtein(a: string, b: string, max: number): number {
  const s = [...a];
  const t = [...b];
  if (Math.abs(s.length - t.length) > max) return max + 1;
  let older = new Array<number>(t.length + 1).fill(0);
  let prev = Array.from({ length: t.length + 1 }, (_, j) => j);
  let cur = new Array<number>(t.length + 1).fill(0);
  for (let i = 1; i <= s.length; i++) {
    cur[0] = i;
    let rowMin = i;
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && s[i - 1] === t[j - 2] && s[i - 2] === t[j - 1]) v = Math.min(v, older[j - 2]! + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    [older, prev, cur] = [prev, cur, older];
  }
  return Math.min(prev[t.length]!, max + 1);
}

interface Candidate {
  term: string;
  length: number;
  doc: number;
}

/** Vocabulary lookups with a per-first-letter candidate cache, dropped whenever the index changes. */
export class FuzzyVocabulary {
  private readonly cache = new Map<string, Candidate[]>();
  private stamp = '';

  constructor(private readonly store: IndexStore) {}

  /** `data_version` covers commits of other connections, `total_changes()` this connection's own writes. */
  private validate(): void {
    const changes = this.store.get<{ c: number }>('SELECT total_changes() AS c')?.c ?? 0;
    const stamp = `${this.store.dataVersion()}:${changes}`;
    if (stamp !== this.stamp) {
      this.cache.clear();
      this.stamp = stamp;
    }
  }

  private byFirstLetter(first: string): Candidate[] {
    let list = this.cache.get(first);
    if (!list) {
      // The range constraint lets fts5vocab seek instead of scanning the whole vocabulary (P0 measurement).
      const next = String.fromCodePoint(first.codePointAt(0)! + 1);
      list = this.store
        .all<{ term: string; doc: number }>('SELECT term, doc FROM turn_vocab WHERE term >= ? AND term < ?', [first, next])
        .map((r) => ({ term: r.term, length: [...r.term].length, doc: r.doc }));
      this.cache.set(first, list);
    }
    return list;
  }

  /** Whether the folded term occurs in any document (`term = ?`). */
  hasDocument(text: string): boolean {
    const term = foldTerm(text);
    if (!SINGLE_TOKEN.test(term)) return true;
    return (this.store.get<{ doc: number }>('SELECT doc FROM turn_vocab WHERE term = ?', [term])?.doc ?? 0) > 0;
  }

  /** R6.5 – nearest vocabulary terms (excluding the term itself), by distance, then document frequency. */
  candidates(text: string, limit = MAX_EXPANSIONS): string[] {
    const term = foldTerm(text);
    const chars = [...term];
    if (chars.length < MIN_FUZZY_CHARS || !SINGLE_TOKEN.test(term)) return [];
    this.validate();
    const max = maxDistance(chars.length);
    const found: { term: string; d: number; doc: number }[] = [];
    for (const c of this.byFirstLetter(chars[0]!)) {
      if (c.term === term || Math.abs(c.length - chars.length) > MAX_LENGTH_DELTA) continue;
      const d = damerauLevenshtein(term, c.term, max);
      if (d <= max) found.push({ term: c.term, d, doc: c.doc });
    }
    found.sort((a, b) => a.d - b.d || b.doc - a.doc || (a.term < b.term ? -1 : 1));
    return found.slice(0, limit).map((f) => f.term);
  }
}

const expandable = (t: Term): t is Extract<Term, { kind: 'term' }> => t.kind === 'term' && !t.prefix;

/**
 * Expands `~term` (and, with `all`, every plain positive term – R6.7) into the term OR its nearest vocabulary
 * terms. Expansions are AST terms, so they are quoted like any other term (R6.1).
 */
export function expandFuzzy(ast: QueryAst, vocab: FuzzyVocabulary, all = false): { ast: QueryAst; expanded: boolean } {
  let expanded = false;
  const clauses = ast.clauses.map((c) => {
    const alternatives: Term[] = [];
    const seen = new Set<string>();
    const add = (t: Term): void => {
      const key = `${t.kind}:${t.kind === 'term' && t.prefix ? '*' : ''}${foldTerm(t.text)}`;
      if (seen.has(key)) return;
      seen.add(key);
      alternatives.push(t);
    };
    for (const t of c.alternatives) {
      add(t);
      if (!expandable(t) || !(t.fuzzy || (all && !c.negated))) continue;
      for (const term of vocab.candidates(t.text)) {
        expanded = true;
        add({ kind: 'term', text: term, prefix: false, fuzzy: false });
      }
    }
    return { ...c, alternatives };
  });
  return { ast: { ...ast, clauses }, expanded };
}

/** R6.6 – replacements for positive plain terms without any document: the best candidate of each. */
export function suggestReplacements(ast: QueryAst, vocab: FuzzyVocabulary): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of ast.clauses) {
    if (c.negated) continue;
    for (const t of c.alternatives) {
      if (!expandable(t) || t.fuzzy || out.has(t.text) || vocab.hasDocument(t.text)) continue;
      const best = vocab.candidates(t.text, 1)[0];
      if (best) out.set(t.text, best);
    }
  }
  return out;
}
