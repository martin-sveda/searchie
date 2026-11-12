import { describe, expect, it } from 'vitest';
import type { StatsResult } from '../query/stats';
import { StatsHostToWebviewSchema, StatsWebviewToHostSchema } from '../webview/stats-protocol';
import { csvCell, csvFileName, localIso, statsCsv } from './csv';
import { redactStats, toolQuery } from './stats-model';

const SECRET = `ghp_${'c'.repeat(36)}`;
const TS = new Date(2026, 0, 15, 12, 30, 5, 7).getTime();

const result = (): StatsResult => ({
  kpis: {
    sessions: 2,
    turns: 3,
    prompts: 3,
    meaningfulPrompts: 2,
    canceled: 0,
    toolCalls: 1,
    activeDays: 1,
    promptTokens: null,
    completionTokens: null,
    credits: 1.5,
    tokenCoverage: null,
    creditCoverage: 0.5,
    avgPromptsPerSession: 1.5,
  },
  bucket: 'day',
  activity: [{ bucket: '2026-01-15', source: 'vscode', prompts: 3, credits: null }],
  workspaces: [{ id: 'folder:/a', label: `=HYPERLINK("x") ${SECRET}`, sessions: 2, prompts: 3, credits: 1.5, lastActivityAt: TS }],
  models: [{ name: '', turns: 3, credits: 1.5 }],
  modes: [{ name: '+mode', turns: 3, credits: null }],
  tools: [{ tool: '@tool,x', calls: 1 }],
  heatmap: Array.from({ length: 7 }, (_, d) => Array.from({ length: 24 }, (_, h) => (d === 2 && h === 12 ? 3 : 0))),
  top: {
    byPrompts: [{ key: 'k', title: `Fix "it"\nnow ${SECRET}`, workspaceName: '-ws', source: 'copilot-cli', prompts: 2, credits: null, durationMs: 60_000 }],
    byCredits: [],
    byDuration: [],
  },
  facets: { sources: ['vscode'], groups: [{ id: 'folder:/a', label: SECRET }], models: [''], modes: ['+mode'] },
  range: { from: TS, to: TS },
  tookMs: 3,
});

describe('CSV export (R9.3)', () => {
  it('writes raw numbers, empty missing values and protected, quoted text', () => {
    expect(csvCell(1234.5, true)).toBe('1234.5');
    expect(csvCell(null, true)).toBe('');
    expect(csvCell(undefined, true)).toBe('');
    expect(csvCell(Number.NaN, true)).toBe('');
    for (const [input, out] of [
      ['=1+1', "'=1+1"],
      ['+1', "'+1"],
      ['-1', "'-1"],
      ['@SUM(A1)', "'@SUM(A1)"],
      ['\tx', "'\tx"],
      ['\rx', `"'\rx"`],
      ['a,b', '"a,b"'],
      ['say "hi"', '"say ""hi"""'],
      ['plain', 'plain'],
    ]) {
      expect(csvCell(input, false)).toBe(out);
    }
    expect(csvCell(`token ${SECRET}`, true)).not.toContain(SECRET);
    expect(csvCell(`token ${SECRET}`, false)).toContain(SECRET);
  });

  it('builds every table with BOM, CRLF and a header row', () => {
    const r = result();
    for (const table of ['kpis', 'activity', 'workspaces', 'models', 'modes', 'tools', 'heatmap', 'top'] as const) {
      const { text, rows } = statsCsv(r, table, true);
      expect(text.startsWith('\uFEFF')).toBe(true);
      expect(text.endsWith('\r\n')).toBe(true);
      expect(text).not.toContain(SECRET);
      expect(text.replaceAll('\r\n', '').includes('\n') && table !== 'top').toBe(false);
      expect(rows).toBeGreaterThan(0);
    }
    expect(statsCsv(r, 'kpis', true).text).toContain('\r\ncredits,1.5\r\n');
    expect(statsCsv(r, 'kpis', true).text).toContain('\r\nprompt_tokens,\r\n');
    expect(statsCsv(r, 'workspaces', true).text).toContain(`"'=HYPERLINK(""x"") [REDACTED`);
    expect(statsCsv(r, 'workspaces', true).text).toContain(`,2,3,1.5,${localIso(TS)}\r\n`);
    expect(statsCsv(r, 'models', true).text).toBe('\uFEFFmodel,turns,credits\r\n,3,1.5\r\n');
    expect(statsCsv(r, 'modes', true).text).toContain("'+mode,3,\r\n");
    expect(statsCsv(r, 'tools', true).text).toContain(`"'@tool,x",1`);
    expect(statsCsv(r, 'heatmap', true).text.split('\r\n')[3]).toBe(`Wed,${Array.from({ length: 24 }, (_, h) => (h === 12 ? 3 : 0)).join(',')}`);
    expect(statsCsv(r, 'top', false).text).toContain(`prompts,1,"Fix ""it""\nnow ${SECRET}",'-ws,copilot-cli,2,,60000`);
  });

  it('formats local ISO timestamps with offset and the default file name', () => {
    expect(localIso(TS)).toMatch(/^2026-01-15T12:30:05\.007[+-]\d{2}:\d{2}$/);
    expect(new Date(localIso(TS)).getTime()).toBe(TS);
    expect(csvFileName('top', TS)).toBe('searchie-top-2026-01-15.csv');
  });
});

describe('statistics view helpers (R9.2, R10.4, R7.20)', () => {
  it('redacts every text cell for display unless disabled', () => {
    const r = result();
    expect(JSON.stringify(redactStats(r, true))).not.toContain(SECRET);
    expect(redactStats(r, false)).toBe(r);
  });

  it('turns a tool click into a tool: query', () => {
    expect(toolQuery('run_in_terminal')).toBe('tool:run_in_terminal');
    expect(toolQuery('my tool "x"')).toBe('tool:"my tool x"');
  });

  it('validates both message directions', () => {
    expect(StatsHostToWebviewSchema.safeParse({ type: 'data', requestId: 1, result: result() }).success).toBe(true);
    expect(StatsHostToWebviewSchema.safeParse({ type: 'data', requestId: 1, result: { ...result(), heatmap: [[1]] } }).success).toBe(false);
    for (const ok of [
      { type: 'ready' },
      { type: 'query', requestId: 2, filter: { after: 1, sources: ['vscode'], bucket: 'week' } },
      { type: 'searchTool', tool: 'bash' },
      { type: 'openSession', key: 'k' },
      { type: 'export', table: 'tools', filter: {} },
      { type: 'rendered', requestId: 2 },
    ]) {
      expect(StatsWebviewToHostSchema.safeParse(ok).success).toBe(true);
    }
    for (const bad of [{ type: 'export', table: 'sessions', filter: {} }, { type: 'query', requestId: 1, filter: { bucket: 'year' } }, { type: 'write', path: '/x' }]) {
      expect(StatsWebviewToHostSchema.safeParse(bad).success).toBe(false);
    }
  });
});
