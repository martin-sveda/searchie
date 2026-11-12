import { describe, expect, it } from 'vitest';
import { parseQuery } from './parse';
import { controlTokens, emptyControls, joinQuery, type QueryControls, setControl, splitQuery } from './query-text';

const NOW = Date.UTC(2026, 0, 20);

describe('R7.13 query ↔ controls', () => {
  it('derives controls from valid filter tokens and keeps everything else verbatim as text', () => {
    const s = splitQuery('fts5 -azure ws:"my proj" src:cli source:insiders "a b" OR x* after:yesterday after:30d in:prompt,tools model:gpt ws:other ~fuz', NOW);
    expect(s.text).toEqual(['fts5', '-azure', '"a b"', 'OR', 'x*', 'after:yesterday', '~fuz']);
    expect(s.controls).toEqual({
      src: ['copilot-cli', 'vscode-insiders'],
      ws: ['my proj', 'other'],
      model: ['gpt'],
      mode: [],
      tool: [],
      file: [],
      in: ['prompt', 'tools'],
      after: '30d',
    });
    expect(s.filters.ws).toEqual(['ws:"my proj"', 'ws:other']);
    expect(s.filters.src).toEqual(['src:cli', 'source:insiders']);
  });

  it('serializes controls canonically: quoted when needed, quotes dropped, all columns = no token', () => {
    const c: QueryControls = { ...emptyControls(), ws: ['my proj', 'a"b', '  '], in: ['tools', 'prompt'], after: '2026-01-01' };
    expect(controlTokens('ws', c)).toEqual(['ws:"my proj"', 'ws:ab']);
    expect(controlTokens('in', c)).toEqual(['in:prompt,tools']);
    expect(controlTokens('in', { ...c, in: ['prompt', 'response', 'tools', 'files', 'title'] })).toEqual([]);
    expect(controlTokens('after', c)).toEqual(['after:2026-01-01']);
    expect(controlTokens('before', c)).toEqual([]);
  });

  it('rewrites only the edited key and appends filters after the text in canonical order', () => {
    const q = 'before:2026-01-01 fix ws:a "x y" model:m';
    const c = { ...splitQuery(q, NOW).controls, ws: ['b c'] };
    expect(setControl(q, 'ws', c, NOW)).toBe('fix "x y" ws:"b c" model:m before:2026-01-01');
    expect(setControl('fix ws:a', 'ws', { ...c, ws: [] }, NOW)).toBe('fix');
    expect(setControl('', 'src', { ...emptyControls(), src: ['copilot-cli'] }, NOW)).toBe('src:copilot-cli');
  });

  it.each([
    'fts5 sql.js ws:searchie after:30d',
    '"open session" -draft OR x src:insiders model:"gpt 6" in:response before:2025-12-31',
    'after:yesterday ~fuzy tool:run_in_terminal file:src/a.ts mode:Agent',
    '',
  ])('round-trips %j: parse(serialize(controls, text)) keeps filters and text', (q) => {
    const s = splitQuery(q, NOW);
    let filters: ReturnType<typeof splitQuery>['filters'] = {};
    for (const key of ['src', 'ws', 'model', 'mode', 'tool', 'file', 'in', 'after', 'before'] as const) filters = { ...filters, [key]: controlTokens(key, s.controls) };
    const again = joinQuery(s.text, filters);
    const s2 = splitQuery(again, NOW);
    expect(s2.text).toEqual(s.text);
    expect(s2.controls).toEqual(s.controls);
    expect(parseQuery(again, NOW).filters).toEqual(parseQuery(q, NOW).filters);
    expect(splitQuery(joinQuery(s2.text, s2.filters), NOW)).toEqual(s2);
  });
});
