import { beforeAll, describe, expect, it } from 'vitest';
import { IndexDb } from '../store/index-db';
import { openNodeSqliteStore } from '../store/node-sqlite-store';
import { CLI_ID, copyFixtureCliRoot, EMPTY_WINDOW_ID, LEGACY_ID, MAIN_ID, stableFixtureUserDir, tempDir } from '../test/helpers';
import { coldBuild, indexPaths } from '../worker/indexer';
import { chooseBucket, normalizeFilter, StatsEngine } from './stats';

const FOLDER_GROUP = 'folder:/home/user/projects/sample-app';
const CLI = `copilot-cli:${CLI_ID}`;
const MAIN = `vscode:${MAIN_ID}`;
const LEGACY = `vscode:${LEGACY_ID}`;
const EMPTY = `vscode:${EMPTY_WINDOW_ID}`;
/** Visible (non-hidden) fixture turns: CLI 0–1, main 0–1, legacy 0, empty window 0 (fixtures README). */
const VISIBLE_TS = [1_768_474_802_000, 1_768_474_830_000, 1_768_467_600_000, 1_768_468_200_000, 1_768_381_200_000, 1_768_471_200_000];
const localDay = (ts: number): string => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

describe('StatsEngine on the fixtures (§9, hand-computed)', () => {
  let stats: StatsEngine;
  beforeAll(async () => {
    const dir = tempDir();
    await coldBuild(indexPaths(dir), {
      vscode: false,
      vscodeInsiders: false,
      copilotCli: false,
      emptyWindow: true,
      additionalSessionRoots: [stableFixtureUserDir(), copyFixtureCliRoot()],
      excludeWorkspaces: [],
      includeThinking: false,
      maxTurnTextKB: 64,
      noisePatterns: [],
    });
    stats = new StatsEngine(new IndexDb(openNodeSqliteStore(indexPaths(dir).live, { readOnly: true })).store);
  });

  it('computes the KPIs over visible turns with coverage (§9.1)', () => {
    const r = stats.compute();
    expect(r.kpis).toEqual({
      sessions: 4,
      turns: 6,
      prompts: 6,
      meaningfulPrompts: 5,
      canceled: 2,
      toolCalls: 5,
      activeDays: new Set(VISIBLE_TS.map(localDay)).size,
      promptTokens: 21_500 + 12_000,
      completionTokens: 450 + 800,
      credits: 4.6,
      tokenCoverage: 2 / 6,
      creditCoverage: 2 / 6,
      avgPromptsPerSession: 1.5,
    });
    expect(r.range).toEqual({ from: Math.min(...VISIBLE_TS), to: Math.max(...VISIBLE_TS) });
  });

  it('groups activity by local day and source, models, modes and tools', () => {
    const r = stats.compute();
    expect(r.bucket).toBe('day');
    const expected = new Map<string, number>();
    for (const [i, ts] of VISIBLE_TS.entries()) {
      const key = `${localDay(ts)}|${i < 2 ? 'copilot-cli' : 'vscode'}`;
      expected.set(key, (expected.get(key) ?? 0) + 1);
    }
    expect(new Map(r.activity.map((a) => [`${a.bucket}|${a.source}`, a.prompts]))).toEqual(expected);
    expect(r.activity.reduce((n, a) => n + (a.credits ?? 0), 0)).toBeCloseTo(4.6);
    expect(r.models).toEqual([
      { name: 'copilot/claude-sonnet-5.5', turns: 3, credits: 1 },
      { name: 'claude-sonnet-5.5', turns: 1, credits: 3.6 },
      { name: 'copilot/gpt-6.1-sol', turns: 1, credits: null },
      { name: 'gpt-6.1-sol', turns: 1, credits: null },
    ]);
    expect(r.modes).toEqual([
      { name: 'Agent', turns: 4, credits: 1 },
      { name: 'autopilot', turns: 1, credits: null },
      { name: 'interactive', turns: 1, credits: 3.6 },
    ]);
    expect(r.tools).toEqual(['bash', 'copilot_readFile', 'create', 'run_in_terminal', 'view'].map((tool) => ({ tool, calls: 1 })));
  });

  it('builds folder groups across sources and the local hour × weekday heatmap', () => {
    const r = stats.compute();
    expect(r.workspaces).toEqual([
      { id: FOLDER_GROUP, label: 'sample-app (VS Code, Copilot CLI)', sessions: 3, prompts: 5, credits: 4.6, lastActivityAt: VISIBLE_TS[1] },
      { id: 'vscode:empty-window', label: 'Empty window (VS Code)', sessions: 1, prompts: 1, credits: null, lastActivityAt: VISIBLE_TS[5] },
    ]);
    const expected = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
    for (const ts of VISIBLE_TS) {
      const d = new Date(ts);
      expected[(d.getDay() + 6) % 7]![d.getHours()]! += 1;
    }
    expect(r.heatmap).toEqual(expected);
    expect(r.facets.groups.map((g) => g.id).sort()).toEqual([FOLDER_GROUP, 'vscode:empty-window']);
    expect(r.facets.sources).toEqual(['copilot-cli', 'vscode']);
    expect(r.facets.modes).toEqual(['Agent', 'autopilot', 'interactive']);
  });

  it('ranks top sessions by prompts, credits and duration (last ts + elapsed − first ts)', () => {
    const { top } = stats.compute();
    expect(top.byPrompts.map((s) => [s.key, s.prompts])).toEqual([
      [CLI, 2],
      [MAIN, 2],
      [LEGACY, 1],
      [EMPTY, 1],
    ]);
    expect(top.byCredits.map((s) => [s.key, s.credits])).toEqual([
      [CLI, 3.6],
      [MAIN, 1],
    ]);
    expect(top.byDuration.map((s) => [s.key, s.durationMs])).toEqual([
      [MAIN, 600_000],
      [CLI, 28_000],
      [LEGACY, 2_100],
      [EMPTY, 0],
    ]);
    expect(top.byPrompts[0]).toMatchObject({ title: 'Sample CLI session', source: 'copilot-cli', workspaceName: 'sample-app (VS Code, Copilot CLI)' });
  });

  it('filters at turn level by source, group, model, mode and date; missing data stays null', () => {
    expect(stats.compute({ sources: ['copilot-cli'] }).kpis).toMatchObject({ sessions: 1, turns: 2, credits: 3.6, toolCalls: 3 });
    expect(stats.compute({ groups: ['vscode:empty-window'] }).kpis).toMatchObject({ sessions: 1, turns: 1, credits: null, promptTokens: null, tokenCoverage: 0 });
    expect(stats.compute({ models: ['gpt-6.1-sol'] }).kpis).toMatchObject({ sessions: 1, turns: 1, canceled: 1 });
    expect(stats.compute({ modes: ['Agent'], groups: [FOLDER_GROUP] }).kpis).toMatchObject({ sessions: 2, turns: 3 });
    expect(stats.compute({ after: 1_768_470_000_000 }).kpis).toMatchObject({ sessions: 2, turns: 3 });
    const none = stats.compute({ after: Date.UTC(2030, 0, 1) });
    expect(none.kpis).toMatchObject({ sessions: 0, turns: 0, prompts: 0, credits: null, tokenCoverage: null, creditCoverage: null, avgPromptsPerSession: null, activeDays: 0 });
    expect(none.top.byPrompts).toEqual([]);
    expect(none.facets.sources).toEqual(['copilot-cli', 'vscode']);
  });

  it('honours a manual bucket and labels weeks by their local Monday', () => {
    const r = stats.compute({ bucket: 'week' });
    expect(r.bucket).toBe('week');
    for (const a of r.activity) expect(new Date(`${a.bucket}T12:00:00`).getDay()).toBe(1);
    expect(stats.compute({ bucket: 'month' }).activity.every((a) => /^\d{4}-\d{2}$/.test(a.bucket))).toBe(true);
  });
});

describe('stats helpers', () => {
  it('chooses day ≤ 60 days, week ≤ 1 year, else month, unless overridden', () => {
    const d = 86_400_000;
    expect(chooseBucket(0, 60 * d, 'auto')).toBe('day');
    expect(chooseBucket(0, 61 * d, undefined)).toBe('week');
    expect(chooseBucket(0, 366 * d, 'auto')).toBe('week');
    expect(chooseBucket(0, 400 * d, 'auto')).toBe('month');
    expect(chooseBucket(null, null, 'auto')).toBe('day');
    expect(chooseBucket(0, 400 * d, 'day')).toBe('day');
  });

  it('normalizes untrusted filters', () => {
    expect(normalizeFilter({ after: '1', before: 5, sources: ['vscode', 'x', 3], groups: 'g', models: ['m'], bucket: 'year', extra: 1 })).toEqual({
      after: undefined,
      before: 5,
      sources: ['vscode'],
      groups: [],
      models: ['m'],
      modes: [],
      bucket: 'auto',
    });
    expect(normalizeFilter(null)).toMatchObject({ bucket: 'auto', sources: [] });
  });
});
