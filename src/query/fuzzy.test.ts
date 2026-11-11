import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { IndexDb } from '../store/index-db';
import { openNodeSqliteStore } from '../store/node-sqlite-store';
import { placeholderRequest, tempDir, writeJsonl } from '../test/helpers';
import { coldBuild, Indexer, type IndexerSettings, indexPaths } from '../worker/indexer';
import { buildMatch } from './fts';
import { damerauLevenshtein, expandFuzzy, foldTerm, FuzzyVocabulary, maxDistance, suggestReplacements } from './fuzzy';
import { parseQuery, replaceTerms } from './parse';

describe('damerauLevenshtein', () => {
  it.each([
    ['kitten', 'sitting', 3, 3],
    ['parser', 'parser', 2, 0],
    ['parser', 'pasrer', 2, 1],
    ['ab', 'ba', 1, 1],
    ['parser', 'parse', 2, 1],
    ['abc', 'abcdef', 2, 3],
    ['abcdef', 'ghijkl', 2, 3],
    ['členů', 'clenu', 2, 2],
    ['', 'ab', 2, 2],
  ])('%s ↔ %s (max %i) = %i', (a, b, max, d) => {
    expect(damerauLevenshtein(a, b, max)).toBe(d);
  });

  it('folds like the tokenizer and caps the distance by length (R6.5)', () => {
    expect(foldTerm('Členů')).toBe('clenu');
    expect(foldTerm('ÉCOLE_x')).toBe('ecole_x');
    expect([maxDistance(3), maxDistance(4), maxDistance(5), maxDistance(12)]).toEqual([1, 1, 2, 2]);
  });
});

describe('expandFuzzy and suggestReplacements', () => {
  const vocab = {
    candidates: (t: string) => (t.toLowerCase().startsWith('par') ? ['parser', 'parse"r', 'parsers'] : []),
    hasDocument: (t: string) => t !== 'parsr' && t !== 'nothing',
  } as unknown as FuzzyVocabulary;

  it('expands ~term and (with all) plain positive terms; prefixes, phrases and negatives stay', () => {
    const { ast, expanded } = expandFuzzy(parseQuery('~parsr pa* "par x" -parq'), vocab);
    expect(expanded).toBe(true);
    // Every expansion is a quoted FTS term (R6.1): a quote inside a vocabulary term is doubled.
    expect(buildMatch(ast)).toBe('(("parsr" OR "parser" OR "parse""r" OR "parsers") AND "pa"* AND "par x") NOT ("parq")');
    expect(expandFuzzy(parseQuery('parsr'), vocab).expanded).toBe(false);
    expect(buildMatch(expandFuzzy(parseQuery('parsr OR Parsr -parq'), vocab, true).ast)).toBe('(("parsr" OR "parser" OR "parse""r" OR "parsers")) NOT ("parq")');
  });

  it('suggests the best candidate for positive plain terms without documents', () => {
    expect([...suggestReplacements(parseQuery('parsr nothing -parsr ~parsr pa* "parsr"'), vocab)]).toEqual([['parsr', 'parser']]);
    expect(replaceTerms('parsr  ws:"a b" -parsr parsr* "parsr" parsr', new Map([['parsr', 'parser']]))).toBe('parser  ws:"a b" -parsr parsr* "parsr" parser');
  });
});

describe('FuzzyVocabulary on a live index', () => {
  const settings = (root: string): IndexerSettings => ({
    vscode: false,
    vscodeInsiders: false,
    copilotCli: false,
    emptyWindow: true,
    additionalSessionRoots: [root],
    excludeWorkspaces: [],
    includeThinking: false,
    maxTurnTextKB: 64,
    noisePatterns: [],
  });
  const session = (dir: string, id: string, text: string): void => {
    writeJsonl(dir, `${id}.jsonl`, [{ kind: 0, v: { version: 3, sessionId: id, creationDate: 1_768_000_000_000, requests: [placeholderRequest(0, text)] } }]);
  };

  it('ranks by distance, then document frequency, and refreshes after the writer adds terms', async () => {
    const root = tempDir();
    const chat = path.join(root, 'globalStorage', 'emptyWindowChatSessions');
    session(chat, 'a', 'migration migrations');
    session(chat, 'b', 'migration');
    const dir = tempDir();
    await coldBuild(indexPaths(dir), settings(root));
    const db = new IndexDb(openNodeSqliteStore(indexPaths(dir).live));
    const vocab = new FuzzyVocabulary(db.store);
    expect(vocab.candidates('migratoin')).toEqual(['migration', 'migrations']);
    expect(vocab.candidates('Mi')).toEqual([]);
    expect(vocab.candidates('mi-gration')).toEqual([]);
    expect(vocab.hasDocument('MIGRATION')).toBe(true);
    expect(vocab.hasDocument('migratoin')).toBe(false);
    expect(vocab.hasDocument('a-b')).toBe(true);
    session(chat, 'c', 'migratoin');
    await new Indexer(db, settings(root)).scan({ force: true });
    expect(vocab.candidates('migratoin')).toEqual(['migration', 'migrations']);
    expect(vocab.candidates('migratio')).toEqual(['migration', 'migrations', 'migratoin']);
    db.store.close();
  });
});
