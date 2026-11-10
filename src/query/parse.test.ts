import { describe, expect, it } from 'vitest';
import { buildFilters, buildMatch, buildNegativeMatch, ftsQuote, hasFilters, likeContains } from './fts';
import { emptyFilters, highlightTerms, parseDate, parseQuery, tokenize } from './parse';

const NOW = new Date(2026, 10, 10, 12, 0, 0).getTime();
const match = (q: string): string | null => buildMatch(parseQuery(q, NOW));

describe('tokenize', () => {
  it('splits on whitespace and keeps quoted segments', () => {
    expect(tokenize('a  "b c"  ws:"my proj" d"e f"')).toEqual([
      { text: 'a', quoted: false, fullyQuoted: false },
      { text: 'b c', quoted: true, fullyQuoted: true },
      { text: 'ws:my proj', quoted: true, fullyQuoted: false },
      { text: 'de f', quoted: true, fullyQuoted: false },
    ]);
  });

  it('runs an unterminated quote to the end and caps input length', () => {
    expect(tokenize('"open session')).toEqual([{ text: 'open session', quoted: true, fullyQuoted: true }]);
    expect(tokenize('x'.repeat(5000))[0]!.text).toHaveLength(2000);
    expect(tokenize('   ')).toEqual([]);
  });
});

describe('parseQuery – syntax elements (§6.1)', () => {
  it('ANDs plain terms', () => {
    expect(match('sql fts5')).toBe('"sql" AND "fts5"');
  });

  it('builds phrases', () => {
    expect(match('"open session"')).toBe('"open session"');
  });

  it('groups OR alternatives and binds AND tighter in clause order', () => {
    expect(match('jest OR vitest config')).toBe('("jest" OR "vitest") AND "config"');
    expect(match('a OR b OR c')).toBe('("a" OR "b" OR "c")');
  });

  it('treats dangling and lowercase OR as words or ignores them', () => {
    expect(match('OR a')).toBe('"a"');
    expect(match('a OR')).toBe('"a"');
    expect(match('a or b')).toBe('"a" AND "or" AND "b"');
  });

  it('excludes negated terms and phrases', () => {
    expect(match('deploy -azure')).toBe('("deploy") NOT ("azure")');
    expect(match('deploy -"azure functions" -aws')).toBe('("deploy") NOT ("azure functions" OR "aws")');
    expect(match('a OR -b')).toBe('("a") NOT ("b")');
  });

  it('supports prefixes of two or more characters', () => {
    expect(match('refact*')).toBe('"refact"*');
    expect(match('r*')).toBe('"r"');
    expect(match('"refact*"')).toBe('"refact*"');
  });

  it('treats ~term as a plain term in Phase 1', () => {
    expect(parseQuery('~reconstuct', NOW).clauses[0]!.alternatives[0]).toEqual({ kind: 'term', text: 'reconstuct', prefix: false, fuzzy: true });
    expect(match('~reconstuct')).toBe('"reconstuct"');
  });

  it('extracts every filter', () => {
    const ast = parseQuery('ws:searchie src:cli source:insiders model:opus mode:agent tool:run_in_terminal file:parser in:prompt,response after:30d before:2026-11-01 x', NOW);
    expect(ast.filters).toEqual({
      ws: ['searchie'],
      src: ['copilot-cli', 'vscode-insiders'],
      model: ['opus'],
      mode: ['agent'],
      tool: ['run_in_terminal'],
      file: ['parser'],
      columns: ['prompt', 'response'],
      after: NOW - 30 * 86_400_000,
      before: new Date(2026, 10, 1).getTime(),
    });
    expect(match('in:prompt,response x')).toBe('{prompt response} : ("x")');
    expect(match('ws:"my project" x')).toBe('"x"');
    expect(parseQuery('ws:"my project"', NOW).filters.ws).toEqual(['my project']);
    expect(parseQuery('src:stable SRC:Code', NOW).filters.src).toEqual(['vscode']);
  });

  it('keeps the strictest of repeated date filters', () => {
    const ast = parseQuery('after:30d after:7d before:2026-11-05 before:2026-11-01', NOW);
    expect(ast.filters.after).toBe(NOW - 7 * 86_400_000);
    expect(ast.filters.before).toBe(new Date(2026, 10, 1).getTime());
  });

  it('collects positive terms for highlighting', () => {
    expect(highlightTerms(parseQuery('Parser "open session" -azure x OR y', NOW))).toEqual(['parser', 'open session', 'x', 'y']);
  });
});

describe('parseQuery – malformed input degrades to plain terms (R6.2)', () => {
  it.each([
    ['after:yesterday', '"after:yesterday"'],
    ['before:2026-02-30', '"before:2026-02-30"'],
    ['in:nonsense', '"in:nonsense"'],
    ['src:emacs', '"src:emacs"'],
    ['foo:bar', '"foo:bar"'],
    ['-ws:x', null],
    ['ws:', '"ws:"'],
  ])('%s → %s', (q, expected) => {
    expect(match(q)).toBe(expected);
  });

  it('reports warnings for bad filters', () => {
    expect(parseQuery('after:yesterday in:x src:emacs', NOW).warnings).toHaveLength(3);
  });

  it('drops tokens without word characters', () => {
    expect(match('* ) ( " -- - ~ ""')).toBeNull();
    expect(parseQuery('* )', NOW).clauses).toEqual([]);
  });

  it('caps the number of clauses', () => {
    const ast = parseQuery(Array.from({ length: 40 }, (_, i) => `t${i}`).join(' '), NOW);
    expect(ast.clauses).toHaveLength(32);
    expect(ast.warnings).toHaveLength(1);
  });
});

describe('FTS generation is injection-safe (R6.1)', () => {
  it.each([
    ['"', null],
    ['a"b', '"ab"'],
    ['*', null],
    ['a*b', '"a*b"'],
    ['NEAR(a b)', '"NEAR(a" AND "b)"'],
    ['NEAR', '"NEAR"'],
    ['a) OR (b', '("a)" OR "(b")'],
    ['AND NOT', '"AND" AND "NOT"'],
    ['{prompt}: x', '"{prompt}:" AND "x"'],
    ['title:x', '"title:x"'],
    ['^start', '"^start"'],
    [`'; DROP TABLE sessions; --`, `"DROP" AND "TABLE" AND "sessions;"`],
  ])('%s → %s', (q, expected) => {
    expect(match(q)).toBe(expected);
  });

  it('doubles inner quotes', () => {
    expect(ftsQuote('a"b')).toBe('"a""b"');
  });
});

describe('negative-only queries', () => {
  it('builds the exclusion expression', () => {
    expect(buildNegativeMatch(parseQuery('-azure -"x y"', NOW))).toBe('"azure" OR "x y"');
    expect(buildNegativeMatch(parseQuery('in:title -azure', NOW))).toBe('{title} : ("azure")');
    expect(buildNegativeMatch(parseQuery('a -b', NOW))).toBeNull();
    expect(buildNegativeMatch(parseQuery('', NOW))).toBeNull();
  });
});

describe('SQL filters (R6.3)', () => {
  it('binds every value', () => {
    const f = buildFilters(parseQuery("ws:a%b model:x_y tool:t file:f mode:m src:cli after:7d before:1d", NOW).filters, { sessionKey: 'k', workspaceId: 'w' });
    expect(f.session.join(' ')).not.toMatch(/a%b|cli/);
    expect(f.sessionParams).toEqual(['k', 'w', '%a\\%b%', 'copilot-cli']);
    expect(f.turnParams).toEqual(['%x\\_y%', '%m%', '%t%', '%f%', NOW - 7 * 86_400_000, NOW - 86_400_000]);
    expect(f.turn).toHaveLength(6);
  });

  it('escapes LIKE wildcards', () => {
    expect(likeContains('50%_\\')).toBe('%50\\%\\_\\\\%');
  });

  it('detects filters', () => {
    expect(hasFilters(emptyFilters())).toBe(false);
    expect(hasFilters({ ...emptyFilters(), after: 1 })).toBe(true);
    expect(hasFilters({ ...emptyFilters(), ws: ['x'] })).toBe(true);
  });
});

describe('parseDate', () => {
  it('handles absolute and relative dates', () => {
    expect(parseDate('2026-01-15', NOW)).toBe(new Date(2026, 0, 15).getTime());
    expect(parseDate('2w', NOW)).toBe(NOW - 14 * 86_400_000);
    const m = new Date(NOW);
    m.setMonth(m.getMonth() - 3);
    expect(parseDate('3m', NOW)).toBe(m.getTime());
    const y = new Date(NOW);
    y.setFullYear(y.getFullYear() - 1);
    expect(parseDate('1y', NOW)).toBe(y.getTime());
    expect(parseDate('3x', NOW)).toBeUndefined();
  });
});
