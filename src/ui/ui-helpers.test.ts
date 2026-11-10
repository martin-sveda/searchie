import { describe, expect, it } from 'vitest';
import type { SessionListItem } from '../store/index-db';
import { escapeMarkdown, formatBytes, formatCount, formatDateTime, formatDuration, plural, relativeTime, shortModel } from './format';
import { compareSessions, dateBucket, filterSummary, groupByDate, groupByWorkspace, workspaceLabel } from './tree-model';

const NOW = new Date(2026, 10, 10, 15, 0, 0).getTime();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const s = (key: string, ws: string, last: number, extra: Partial<SessionListItem> = {}): SessionListItem => ({
  key,
  id: key,
  source: 'vscode',
  workspaceId: ws,
  workspaceName: ws.split(':')[1] ?? ws,
  title: key,
  createdAt: last - HOUR,
  lastActivityAt: last,
  turnCount: 1,
  promptCount: 1,
  ...extra,
});

describe('format', () => {
  it('formats relative times', () => {
    expect(relativeTime(NOW - 10_000, NOW)).toBe('just now');
    expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe('5m ago');
    expect(relativeTime(NOW - 2 * HOUR, NOW)).toBe('2h ago');
    expect(relativeTime(NOW - 3 * DAY, NOW)).toBe('3d ago');
    expect(relativeTime(new Date(2026, 8, 3).getTime(), NOW)).toBe('Sep 3');
    expect(relativeTime(new Date(2025, 8, 3).getTime(), NOW)).toBe('Sep 3, 2025');
  });

  it('formats counts, bytes, durations and dates; missing data is a dash', () => {
    expect(formatCount(6210)).toBe('6\u00a0210');
    expect(formatCount(3100, true)).toBe('3.1k');
    expect(formatCount(250_000, true)).toBe('250k');
    expect(formatCount(2000, true)).toBe('2k');
    expect(formatCount(1.25)).toBe('1.3');
    expect(formatCount(undefined)).toBe('—');
    expect(formatCount(null)).toBe('—');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
    expect(formatDuration(undefined)).toBe('—');
    expect(formatDuration(450)).toBe('450 ms');
    expect(formatDuration(42_000)).toBe('42 s');
    expect(formatDuration(125_000)).toBe('2 min 5 s');
    expect(formatDuration(2 * HOUR + 5 * 60_000)).toBe('2 h 5 min');
    expect(formatDateTime(0)).toBe('—');
    expect(formatDateTime(new Date(2026, 0, 2, 3, 4).getTime())).toBe('2026-01-02 03:04');
    expect(plural(1, 'prompt')).toBe('1 prompt');
    expect(plural(2, 'prompt')).toBe('2 prompts');
    expect(shortModel('copilot/claude-sonnet-5.5')).toBe('claude-sonnet-5.5');
    expect(shortModel(undefined)).toBeUndefined();
  });

  it('escapes markdown from session data', () => {
    expect(escapeMarkdown('[x](http://a) <b> *y*')).toBe('\\[x\\]\\(http://a\\) \\<b\\> \\*y\\*');
  });
});

describe('tree model', () => {
  it('buckets dates', () => {
    expect(dateBucket(NOW - HOUR, NOW).id).toBe('today');
    expect(dateBucket(NOW - DAY, NOW).id).toBe('yesterday');
    expect(dateBucket(NOW - 5 * DAY, NOW).id).toBe('week');
    expect(dateBucket(NOW - 20 * DAY, NOW).id).toBe('month');
    expect(dateBucket(new Date(2026, 5, 1).getTime(), NOW)).toEqual({ id: '2026-06', label: 'June 2026', order: 9 });
  });

  it('pins the current workspace and orders the rest by last activity (R7.4)', () => {
    const groups = groupByWorkspace([s('a', 'vscode:x', NOW - DAY), s('b', 'vscode:y', NOW - HOUR), s('c', 'vscode:cur', NOW - 10 * DAY), s('d', 'vscode:y', NOW)], new Set(['vscode:cur']), 'lastActivity');
    expect(groups.map((g) => [g.id, g.current, g.sessions.map((x) => x.key)])).toEqual([
      ['vscode:cur', true, ['c']],
      ['vscode:y', false, ['d', 'b']],
      ['vscode:x', false, ['a']],
    ]);
    expect(workspaceLabel('searchie', 'vscode-insiders')).toBe('searchie (Insiders)');
  });

  it('sorts by created, prompts and credits (R7.2)', () => {
    const a = s('a', 'w', NOW, { createdAt: 1, promptCount: 9, credits: 1 });
    const b = s('b', 'w', NOW - 1, { createdAt: 2, promptCount: 1, credits: undefined });
    const c = s('c', 'w', NOW - 2, { createdAt: 3, promptCount: 5, credits: 7 });
    const keys = (sort: Parameters<typeof compareSessions>[0]): string[] => [a, b, c].sort(compareSessions(sort)).map((x) => x.key);
    expect(keys('lastActivity')).toEqual(['a', 'b', 'c']);
    expect(keys('created')).toEqual(['c', 'b', 'a']);
    expect(keys('prompts')).toEqual(['a', 'c', 'b']);
    expect(keys('credits')).toEqual(['c', 'a', 'b']);
  });

  it('groups by date in bucket order', () => {
    const g = groupByDate([s('old', 'w', NOW - 40 * DAY), s('t', 'w', NOW - HOUR), s('y', 'w', NOW - DAY)], 'lastActivity', NOW);
    expect(g.map((x) => x.bucket.id)).toEqual(['today', 'yesterday', '2026-10']);
  });

  it('summarizes filters', () => {
    expect(filterSummary({})).toBeUndefined();
    expect(filterSummary({ sources: ['vscode-insiders'], models: ['m'], modes: ['Agent'], days: 30 })).toBe('Insiders · m · Agent · last 30 days');
  });
});
