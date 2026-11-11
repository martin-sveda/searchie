import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { IndexDb } from '../store/index-db';
import { openNodeSqliteStore } from '../store/node-sqlite-store';
import { EMPTY_WINDOW_ID, stableFixtureUserDir, LEGACY_ID, MAIN_ID, placeholderRequest, tempDir, WS_FOLDER_HASH, writeJsonl } from '../test/helpers';
import { coldBuild, type IndexerSettings, indexPaths } from '../worker/indexer';
import { QueryEngine, type SearchResponse } from './engine';
import { mergeWeights, sessionScore, turnScore } from './ranking';
import { cleanSnippet, escapeHtml, MARK_END, MARK_START, snippetToHtml, snippetToPlain } from './snippet';

const MAIN = `vscode:${MAIN_ID}`;
const LEGACY = `vscode:${LEGACY_ID}`;
const EMPTY = `vscode:${EMPTY_WINDOW_ID}`;
const NOW = Date.UTC(2026, 0, 20);

const settings = (root: string, extra: Partial<IndexerSettings> = {}): IndexerSettings => ({
  vscode: false,
  vscodeInsiders: false,
  emptyWindow: true,
  additionalSessionRoots: [root],
  excludeWorkspaces: [],
  includeThinking: false,
  maxTurnTextKB: 64,
  noisePatterns: [],
  ...extra,
});

async function engineFor(root: string, extra: Partial<IndexerSettings> = {}): Promise<QueryEngine> {
  const dir = tempDir();
  await coldBuild(indexPaths(dir), settings(root, extra));
  return new QueryEngine(new IndexDb(openNodeSqliteStore(indexPaths(dir).live, { readOnly: true })).store);
}

const keys = (r: SearchResponse): string[] => r.results.map((x) => x.session.key);

describe('QueryEngine on the fixtures – golden queries (expected top 3)', () => {
  let engine: QueryEngine;
  const q = (query: string, extra: Partial<Parameters<QueryEngine['search']>[0]> = {}): SearchResponse => engine.search({ query, now: NOW, ...extra });
  beforeAll(async () => {
    engine = await engineFor(stableFixtureUserDir());
  });

  it.each([
    ['parser', [MAIN]],
    ['clenu', [MAIN]],
    ['členů', [MAIN]],
    ['"build script"', [LEGACY]],
    ['refact*', [MAIN]],
    ['placeholder', [MAIN, EMPTY, LEGACY]],
    ['placeholder answer', [MAIN]],
    ['explain OR "what is"', [EMPTY, LEGACY]],
    ['json line', [MAIN]],
    ['parse_json_line', []],
    ['parser-utils', [MAIN]],
    ['run_in_terminal', [MAIN]],
    ['npm test', [MAIN]],
    ['~placeholdr', []],
  ])('%s → %j', (query, expected) => {
    expect(keys(q(query))).toEqual(expected);
  });

  it('excludes hidden turns and never matches tool output or attachments (R4.8, R4.9)', () => {
    expect(keys(q('todo'))).toEqual([]);
    expect(keys(q('"must never be indexed"'))).toEqual([]);
  });

  it('applies filters (R6.3)', () => {
    expect(keys(q('placeholder ws:sample'))).toEqual([MAIN, LEGACY]);
    expect(keys(q('placeholder ws:empty'))).toEqual([EMPTY]);
    expect(keys(q('placeholder src:insiders'))).toEqual([]);
    expect(keys(q('placeholder src:vscode model:gpt'))).toEqual([LEGACY]);
    expect(keys(q('placeholder mode:AGENT tool:read'))).toEqual([MAIN]);
    expect(keys(q('placeholder file:parser-utils'))).toEqual([MAIN]);
    expect(keys(q('placeholder after:2026-01-15'))).toEqual([MAIN, EMPTY]);
    expect(keys(q('placeholder before:2026-01-15'))).toEqual([LEGACY]);
    expect(keys(q('in:title refactoring'))).toEqual([MAIN]);
    expect(keys(q('in:prompt placeholder'))).toEqual([EMPTY]);
    expect(keys(q('in:files parser'))).toEqual([MAIN]);
  });

  it('lists sessions by last activity for empty and filter-only queries (R6.4)', () => {
    const all = q('');
    expect(all.mode).toBe('list');
    expect(keys(all)).toEqual([EMPTY, MAIN, LEGACY]);
    expect(all.total).toBe(3);
    expect(keys(q('model:gpt'))).toEqual([LEGACY]);
    expect(keys(q('ws:sample-app'))).toEqual([MAIN, LEGACY]);
    expect(keys(q('-build'))).toEqual([EMPTY, MAIN]);
    expect(keys(q('src:cli'))).toEqual([]);
  });

  it('pages results (R6.9)', () => {
    const p1 = q('placeholder', { limit: 2 });
    expect(p1.total).toBe(3);
    expect(keys(p1)).toEqual([MAIN, EMPTY]);
    const p2 = q('placeholder', { limit: 2, offset: 2 });
    expect(keys(p2)).toEqual([LEGACY]);
    expect(p2.total).toBe(3);
    const past = q('placeholder', { limit: 2, offset: 10 });
    expect(past.results).toEqual([]);
    expect(past.total).toBe(3);
    expect(keys(q('', { limit: 1, offset: 1 }))).toEqual([MAIN]);
  });

  it('returns up to 3 hits with marked snippets from the best column (§6.4)', () => {
    const r = q('placeholder');
    const main = r.results.find((x) => x.session.key === MAIN)!;
    expect(main.matchCount).toBe(2);
    expect(main.hits.map((h) => h.turnIndex)).toEqual([0, 1]);
    for (const h of main.hits) expect(h.snippet).toContain(MARK_START);
    expect(main.hits[0]!.column).toBe('response');
    expect(q('in:files parser').results[0]!.hits[0]!.column).toBe('files');
    expect(q('json line').results[0]!.hits[0]!.snippet).not.toContain(MARK_START);
    expect(r.terms).toEqual(['placeholder']);
    expect(r.tookMs).toBeGreaterThanOrEqual(0);
  });

  it('penalizes noise prompts (R5.10)', () => {
    const r = q('continue');
    expect(keys(r)).toEqual([MAIN]);
    expect(r.results[0]!.hits[0]!.turnIndex).toBe(1);
  });

  it('honours internal scopes (R7.5)', () => {
    expect(keys(q('placeholder', { scope: { sessionKey: MAIN } }))).toEqual([MAIN]);
    expect(keys(q('placeholder', { scope: { workspaceId: `vscode:${WS_FOLDER_HASH}` } }))).toEqual([MAIN, LEGACY]);
    expect(keys(q('', { scope: { workspaceId: 'vscode:empty-window' } }))).toEqual([EMPTY]);
  });

  it('gives the same ranking with SQL and JS scoring', () => {
    const sql = q('placeholder OR parser');
    engine.setMathFunctions(false);
    const js = q('placeholder OR parser');
    const jsPaged = q('placeholder OR parser', { limit: 1, offset: 1 });
    engine.setMathFunctions(true);
    expect(keys(js)).toEqual(keys(sql));
    expect(js.results.map((r) => r.score)).toEqual(sql.results.map((r) => expect.closeTo(r.score, 6) as unknown as number));
    expect(keys(jsPaged)).toEqual([keys(sql)[1]]);
    expect(jsPaged.total).toBe(sql.total);
    expect(engine.hasMathFunctions()).toBe(true);
  });

  it.each(['"', '*', 'NEAR(a b)', 'a) OR (b', '{prompt}: x', "'; DROP TABLE sessions; --", 'AND', 'NOT OR', '-', '^x', 'col:val:"x'])('never fails on %j', (query) => {
    const r = q(query);
    expect(r.warnings.filter((w) => w.startsWith('search failed'))).toEqual([]);
  });
});

describe('ranking properties (placeholder corpus)', () => {
  let engine: QueryEngine;
  beforeAll(async () => {
    const root = tempDir();
    const chat = path.join(root, 'workspaceStorage', 'ranking', 'chatSessions');
    const day = 86_400_000;
    const session = (id: string, created: number, requests: Record<string, unknown>[], extra: Record<string, unknown> = {}): void => {
      writeJsonl(chat, `${id}.jsonl`, [{ kind: 0, v: { sessionId: id, creationDate: created, requests: requests.map((r, i) => ({ ...r, timestamp: created + i * 1000 })), ...extra } }]);
    };
    const filler = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor';
    session('title-hit', NOW - day, [placeholderRequest(0, `first ${filler}`)], { customTitle: 'Gizmo design' });
    session('prompt-hit', NOW - day, [placeholderRequest(0, `gizmo ${filler}`)], { customTitle: 'Untitled one' });
    session('response-hit', NOW - day, [placeholderRequest(0, `second ${filler}`, { response: [{ value: `gizmo ${filler}` }] })], { customTitle: 'Untitled two' });
    session('new', NOW - day, [placeholderRequest(0, `widget ${filler}`)], { customTitle: 'Same a' });
    session('old', NOW - 400 * day, [placeholderRequest(0, `widget ${filler}`)], { customTitle: 'Same b' });
    session('many', NOW - day, [0, 1, 2].map((i) => placeholderRequest(i, `sprocket ${filler}`)), { customTitle: 'Same c' });
    session('one', NOW - day, [placeholderRequest(0, `sprocket ${filler}`)], { customTitle: 'Same d' });
    session('noisy', NOW - day, [placeholderRequest(0, 'gadget')], { customTitle: 'Same e' });
    session('clean', NOW - day, [placeholderRequest(0, `gadget ${filler}`)], { customTitle: 'Same f' });
    session('secret', NOW - day, [placeholderRequest(0, `token ghp_${'a'.repeat(36)} rotate`)], { customTitle: 'Same g' });
    engine = await engineFor(root, { emptyWindow: false, noisePatterns: ['gadget'] });
  });
  const q = (query: string, redact = true): SearchResponse => engine.search({ query, now: NOW, redact });
  const ids = (r: SearchResponse): string[] => r.results.map((x) => x.session.id);

  it('weights title > prompt > response', () => {
    expect(ids(q('gizmo'))).toEqual(['title-hit', 'prompt-hit', 'response-hit']);
  });

  it('boosts recent turns', () => {
    expect(ids(q('widget'))).toEqual(['new', 'old']);
    const flat = engine.search({ query: 'widget', now: NOW, recencyBoost: 0 });
    expect(flat.results[0]!.score).toBeCloseTo(flat.results[1]!.score, 6);
  });

  it('boosts sessions with more matching turns', () => {
    const r = q('sprocket');
    expect(ids(r)).toEqual(['many', 'one']);
    expect(r.results[0]!.matchCount).toBe(3);
  });

  it('penalizes noise prompts', () => {
    expect(ids(q('gadget'))).toEqual(['clean', 'noisy']);
  });

  it('redacts secrets in snippets unless disabled (R6.11)', () => {
    const red = q('rotate').results[0]!.hits[0]!.snippet;
    expect(red).toContain('[REDACTED:github-token]');
    expect(red).not.toContain('ghp_');
    expect(q('rotate', false).results[0]!.hits[0]!.snippet).toContain('ghp_');
  });

  it('accepts weight overrides (R6.8)', () => {
    const r = engine.search({ query: 'gizmo', now: NOW, weights: { title: 0, prompt: 0, response: 10 } });
    expect(ids(r)[0]).toBe('response-hit');
  });
});

describe('ranking and snippet helpers', () => {
  it('computes §6.3 scores', () => {
    expect(turnScore(-2, 0, false, 0, 0.2)).toBeCloseTo(2.4);
    expect(turnScore(-2, 0, true, 0, 0.2)).toBeCloseTo(0.48);
    expect(turnScore(-2, 0, false, 90 * 86_400_000, 0.2)).toBeCloseTo(2 * (1 + 0.2 / Math.E));
    expect(sessionScore(1, 1)).toBe(1);
    expect(sessionScore(1, Math.E)).toBeCloseTo(1.25);
    expect(mergeWeights({ title: 9, prompt: -1, response: 'x' })).toMatchObject({ title: 9, prompt: 4, response: 1 });
    expect(mergeWeights(undefined).aux).toBe(0.5);
  });

  it('escapes first and marks second (R6.10)', () => {
    const s = `<script>alert(1)</script> ${MARK_START}hit${MARK_END} & "q" 'a' ${MARK_END}${MARK_START}open`;
    expect(snippetToHtml(s)).toBe('&lt;script&gt;alert(1)&lt;/script&gt; <mark>hit</mark> &amp; &quot;q&quot; &#39;a&#39; <mark>open</mark>');
    expect(escapeHtml('<img onerror=x>')).toBe('&lt;img onerror=x&gt;');
    expect(snippetToPlain(`a ${MARK_START}b${MARK_END}`)).toBe('a «b»');
    expect(cleanSnippet(' a \n\t b ', false)).toBe('a b');
  });
});
