import { describe, expect, it } from 'vitest';
import {
  capText,
  createNoiseMatcher,
  expandPaths,
  fileUriToPath,
  globToRegExp,
  identifierParts,
  isNoise,
  matchesAnyGlob,
  oneLine,
  uriLikeToPath,
} from './text';

describe('isNoise (R5.10)', () => {
  it.each([
    'continue',
    'Continue.',
    '@agent continue',
    '@agent Try Again',
    'retry',
    'stop',
    'cancel',
    'abort!',
    'y',
    'N',
    'yes',
    'no.',
    '?!',
    '...',
    'Continue to iterate?',
    'systemd says hi',
    'System: auth',
  ])('treats %j as noise', (p) => expect(isNoise(p)).toBe(true));

  it.each(['', '   ', 'continue with the parser refactoring', 'yesterday', 'nope', 'please continue to iterate on the parser module and add tests for all the edge cases we found'])(
    'treats %j as meaningful',
    (p) => expect(isNoise(p)).toBe(false),
  );

  it('does not treat long prompts as noise (unlike Searchie prototype)', () => {
    expect(isNoise('word '.repeat(1000))).toBe(false);
  });

  it('applies case-insensitive user patterns to the whole trimmed prompt and reports invalid ones', () => {
    const invalid: string[] = [];
    const m = createNoiseMatcher(['pokračuj', 'ok(ay)?', '(', '', '  '], (p) => invalid.push(p));
    expect(m('  POKRAČUJ ')).toBe(true);
    expect(m('okay')).toBe(true);
    expect(m('ok then let us go')).toBe(false);
    expect(m('pokračuj s refaktoringem')).toBe(false);
    expect(invalid).toEqual(['(']);
  });
});

describe('identifierParts (R5.7)', () => {
  it('splits camelCase, PascalCase, snake_case and acronyms', () => {
    expect(identifierParts('refactor parseJsonLine now')).toBe('parse json line');
    expect(identifierParts('ParseWorker run_in_terminal parseJSONLine')).toBe('parse worker run in terminal parse json line');
  });

  it('ignores plain words and de-duplicates', () => {
    expect(identifierParts('plain words only')).toBe('');
    expect(identifierParts('fooBar fooBar')).toBe('foo bar');
  });

  it('caps the number of identifiers', () => {
    const text = Array.from({ length: 2500 }, (_, i) => `id${i}Name`).join(' ');
    expect(identifierParts(text).split(' ').length).toBe(2000 * 2);
  });
});

describe('expandPaths (R5.8)', () => {
  it('adds basename and stem per unique path', () => {
    expect(expandPaths(['/w/src/parser-vscode.ts', '/w/src/parser-vscode.ts', 'C:\\w\\Makefile', ''])).toBe(
      '/w/src/parser-vscode.ts parser-vscode.ts parser-vscode C:\\w\\Makefile Makefile',
    );
  });
});

describe('capText / oneLine', () => {
  it('does not split surrogate pairs', () => {
    expect(capText('ab😀cd', 3)).toBe('ab');
    expect(capText('abc', 10)).toBe('abc');
  });

  it('collapses whitespace and adds an ellipsis', () => {
    expect(oneLine('  a \n b  ')).toBe('a b');
    expect(oneLine('x'.repeat(100), 10)).toBe(`${'x'.repeat(9)}…`);
  });
});

describe('uri helpers', () => {
  it('converts file URIs on POSIX, Windows and UNC', () => {
    expect(fileUriToPath('file:///home/u/a%20b.ts')).toBe('/home/u/a b.ts');
    expect(fileUriToPath('file:///c%3A/Users/u/x.ts')).toBe('c:/Users/u/x.ts');
    expect(fileUriToPath('file://server/share/x')).toBe('//server/share/x');
    expect(fileUriToPath('file:///bad%E0%A4%A')).toBe('/bad%E0%A4%A');
    expect(fileUriToPath('/plain/path')).toBe('/plain/path');
  });

  it('reads serialized VS Code URIs', () => {
    expect(uriLikeToPath({ fsPath: '/a' })).toBe('/a');
    expect(uriLikeToPath({ external: 'file:///b' })).toBe('/b');
    expect(uriLikeToPath({ path: '/c' })).toBe('/c');
    expect(uriLikeToPath({})).toBe('');
    expect(uriLikeToPath(null)).toBe('');
    expect(uriLikeToPath(5)).toBe('');
    expect(uriLikeToPath('file:///d')).toBe('/d');
  });
});

describe('globs (R3.3)', () => {
  it('translates **, * and ?', () => {
    expect(globToRegExp('**/scratch/**').test('/home/u/scratch/x/y')).toBe(true);
    expect(globToRegExp('/home/*/tmp').test('/home/u/tmp')).toBe(true);
    expect(globToRegExp('/home/*/tmp').test('/home/u/v/tmp')).toBe(false);
    expect(globToRegExp('a?c').test('abc')).toBe(true);
    expect(globToRegExp('a.c').test('abc')).toBe(false);
    expect(globToRegExp('**').test('anything/at/all')).toBe(true);
  });

  it('matches basenames for slash-less patterns and folders themselves for path patterns', () => {
    expect(matchesAnyGlob('/home/u/projects/sample-app', ['sample-*'])).toBe(true);
    expect(matchesAnyGlob('/home/u/projects/sample-app', ['**/projects/**'])).toBe(true);
    expect(matchesAnyGlob('/home/u/scratch', ['**/scratch/**'])).toBe(true);
    expect(matchesAnyGlob('C:\\Users\\u\\Scratch', ['**/scratch'])).toBe(true);
    expect(matchesAnyGlob('/home/u/other', ['sample-*', '', 5 as unknown as string])).toBe(false);
  });
});
