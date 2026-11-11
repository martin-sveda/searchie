import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { IndexDb } from '../store/index-db';
import { openNodeSqliteStore } from '../store/node-sqlite-store';
import { indexConfigValue, META } from '../store/schema';
import {
  copyFixtureUserDir,
  EMPTY_WINDOW_ID,
  FIXTURE_USER_DIR,
  LEGACY_ID,
  MAIN_ID,
  NEVER_INDEXED,
  tempDir,
  WS_FILE_HASH,
  WS_FOLDER_HASH,
} from '../test/helpers';
import { CancelledError, coldBuild, Indexer, type IndexerSettings, indexPaths, rebuildReason, THROTTLE_MS } from './indexer';

const settingsFor = (userDir: string, extra: Partial<IndexerSettings> = {}): IndexerSettings => ({
  vscode: false,
  vscodeInsiders: false,
  emptyWindow: true,
  additionalSessionRoots: [userDir],
  excludeWorkspaces: [],
  includeThinking: false,
  maxTurnTextKB: 64,
  noisePatterns: [],
  ...extra,
});

const MAIN_KEY = `vscode:${MAIN_ID}`;
const LEGACY_KEY = `vscode:${LEGACY_ID}`;

function openLive(dir: string): IndexDb {
  return new IndexDb(openNodeSqliteStore(indexPaths(dir).live));
}

function match(db: IndexDb, expr: string): { key: string; idx: number }[] {
  return db.store.all<{ key: string; idx: number }>(
    'SELECT t.session_key AS key, t.idx FROM turn_fts JOIN turns t ON t.id = turn_fts.rowid WHERE turn_fts MATCH ? ORDER BY key, idx',
    [expr],
  );
}

describe('coldBuild on the fixtures', () => {
  let dir: string;
  let db: IndexDb;
  beforeEach(async () => {
    dir = tempDir();
    const stats = await coldBuild(indexPaths(dir), settingsFor(FIXTURE_USER_DIR));
    // The two copies of the main session may have different mtimes (e.g. on Windows checkouts); the newer one
    // then replaces the first, so the write count is 3 or 4. The resulting index is the same.
    expect(stats).toMatchObject({ workspaces: 3, files: 4, parsed: 4, duplicates: 1, failed: 0 });
    expect(stats.sessionsWritten).toBeGreaterThanOrEqual(3);
    db = openLive(dir);
    expect(db.store.get<{ n: number }>('SELECT count(*) AS n FROM sessions')?.n).toBe(3);
  });

  it('publishes a current index and removes the build file', () => {
    expect(fs.existsSync(indexPaths(dir).build)).toBe(false);
    expect(rebuildReason(db, settingsFor(FIXTURE_USER_DIR))).toBeNull();
    expect(rebuildReason(db, settingsFor(FIXTURE_USER_DIR, { includeThinking: true }))).toBe('index-config');
    expect(rebuildReason(db, settingsFor(FIXTURE_USER_DIR, { maxTurnTextKB: 32 }))).toBe('index-config');
    db.setMeta(META.parserVersion, '0');
    expect(rebuildReason(db, settingsFor(FIXTURE_USER_DIR))).toBe('parser-version');
    db.setMeta(META.schemaVersion, '0');
    expect(rebuildReason(db, settingsFor(FIXTURE_USER_DIR))).toBe('schema-version');
    expect(db.getMeta(META.indexConfig)).toBe(indexConfigValue({ includeThinking: false, maxTurnTextKB: 64 }));
  });

  it('indexes one row per session id and keeps the copy as duplicate (R5.19)', () => {
    expect(db.store.all<{ key: string }>('SELECT key FROM sessions ORDER BY key').map((r) => r.key)).toEqual([
      `vscode:${MAIN_ID}`,
      `vscode:${LEGACY_ID}`,
      `vscode:${EMPTY_WINDOW_ID}`,
    ]);
    const files = db.filesOfSession(MAIN_KEY);
    expect(files.map((f) => f.status).sort()).toEqual(['duplicate', 'ok']);
    expect(db.store.all('SELECT * FROM turns WHERE session_key NOT IN (SELECT key FROM sessions)')).toEqual([]);
  });

  it('computes the session metadata of the main fixture', () => {
    const m = db.sessionMeta(MAIN_KEY)!;
    expect(m).toMatchObject({
      id: MAIN_ID,
      title: 'Sample parser refactoring',
      turnCount: 2,
      promptCount: 2,
      noisePromptCount: 1,
      canceledCount: 1,
      toolCallCount: 2,
      promptTokens: 12_000,
      completionTokens: 800,
      credits: 1,
      models: { 'copilot/claude-sonnet-5.5': 2 },
      modes: { Agent: 2 },
      tools: { copilot_readFile: 1, run_in_terminal: 1 },
    });
    expect(m.copies).toHaveLength(1);
    expect([m.workspaceId, m.copies[0]!.workspaceId].sort()).toEqual([`vscode:${WS_FOLDER_HASH}`, `vscode:${WS_FILE_HASH}`]);
    expect(db.sessionMeta('missing')).toBeUndefined();
  });

  it('supports diacritics folding, identifier split and path expansion (R5.6–R5.8)', () => {
    expect(match(db, 'clenu')).toEqual([{ key: MAIN_KEY, idx: 0 }]);
    expect(match(db, '"json line"')).toEqual([{ key: MAIN_KEY, idx: 0 }]);
    expect(match(db, '{files}: "parser-utils"')).toEqual([{ key: MAIN_KEY, idx: 0 }]);
    expect(match(db, '{tools}: run_in_terminal')).toEqual([{ key: MAIN_KEY, idx: 0 }]);
    expect(match(db, '{title}: refactoring')).toHaveLength(3);
  });

  it('never indexes attachment content, tool output or thinking by default (R4.8, R4.9)', () => {
    expect(match(db, `"${NEVER_INDEXED}"`)).toEqual([]);
    expect(match(db, 'placeholder AND reasoning')).toEqual([]);
  });

  it('lists sessions, facets and a summary', () => {
    expect(db.listSessions().map((s) => s.key)).toEqual([`vscode:${EMPTY_WINDOW_ID}`, MAIN_KEY, LEGACY_KEY]);
    expect(db.listSessions({ workspaceId: 'vscode:empty-window' })).toHaveLength(1);
    expect(db.listSessions({ sources: ['vscode-insiders'] })).toHaveLength(0);
    expect(db.listSessions({ models: ['copilot/gpt-6.1-sol'] }).map((s) => s.key)).toEqual([LEGACY_KEY]);
    expect(db.listSessions({ modes: ['Agent'], after: 1_768_400_000_000, before: 1_768_470_000_000 }).map((s) => s.key)).toEqual([MAIN_KEY]);
    expect(db.facets()).toEqual({ models: ['copilot/claude-sonnet-5.5', 'copilot/gpt-6.1-sol'], modes: ['Agent'], sources: ['vscode'] });
    const sum = db.summary(1_768_500_000_000);
    expect(sum).toMatchObject({ sessions: 3, prompts: 4, workspaces: 2, failedFiles: 0 });
    expect(sum.credits30d).toBe(1);
    expect(db.summary(Date.UTC(2030, 0, 1)).credits30d).toBeNull();
  });

  it('indexes thinking into aux when enabled (R5.9a)', async () => {
    const d2 = tempDir();
    await coldBuild(indexPaths(d2), settingsFor(FIXTURE_USER_DIR, { includeThinking: true }));
    const db2 = openLive(d2);
    expect(match(db2, '{aux}: reasoning')).toEqual([{ key: MAIN_KEY, idx: 0 }]);
    db2.store.close();
  });
});

describe('incremental scans (§5.5)', () => {
  let userDir: string;
  let dir: string;
  let settings: IndexerSettings;
  let db: IndexDb;
  let indexer: Indexer;
  const chat = (hash: string): string => path.join(userDir, 'workspaceStorage', hash, 'chatSessions');

  beforeEach(async () => {
    userDir = copyFixtureUserDir();
    dir = tempDir();
    settings = settingsFor(userDir);
    await coldBuild(indexPaths(dir), settings);
    db = openLive(dir);
    indexer = new Indexer(db, settings);
  });

  it('skips unchanged workspaces via the fingerprint', async () => {
    const s = await indexer.scan();
    expect(s).toMatchObject({ changedWorkspaces: 0, parsed: 0, removedFiles: 0 });
  });

  it('re-indexes only the appended file', async () => {
    const file = path.join(chat(WS_FOLDER_HASH), `${LEGACY_ID}.json`);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { customTitle?: string };
    raw.customTitle = 'Renamed placeholder session';
    fs.writeFileSync(file, JSON.stringify(raw));
    const s = await indexer.scan();
    expect(s).toMatchObject({ changedWorkspaces: 1, parsed: 1, sessionsWritten: 1 });
    expect(db.sessionMeta(LEGACY_KEY)?.title).toBe('Renamed placeholder session');
    expect(match(db, 'renamed')).toEqual([{ key: LEGACY_KEY, idx: 0 }]);
  });

  it('removes deleted files and promotes the remaining duplicate (R5.19)', async () => {
    const winner = db.sessionFile(MAIN_KEY)!;
    fs.rmSync(winner);
    const s = await indexer.scan();
    expect(s.removedFiles).toBe(1);
    const now = db.sessionFile(MAIN_KEY);
    expect(now).toBeDefined();
    expect(now).not.toBe(winner);
    expect(db.sessionMeta(MAIN_KEY)?.copies).toEqual([]);
    expect(match(db, 'clenu')).toEqual([{ key: MAIN_KEY, idx: 0 }]);
    fs.rmSync(now!);
    await indexer.scan();
    expect(db.sessionMeta(MAIN_KEY)).toBeUndefined();
    expect(match(db, 'clenu')).toEqual([]);
  });

  it('keeps the newest copy as the winner', async () => {
    const loser = db.filesOfSession(MAIN_KEY).find((f) => f.status === 'duplicate')!.path;
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(loser, future, future);
    await indexer.scan();
    expect(db.sessionFile(MAIN_KEY)).toBe(loser);
    expect(db.filesOfSession(MAIN_KEY).filter((f) => f.status === 'ok')).toHaveLength(1);
  });

  it('drops excluded workspaces and their sessions (R3.3)', async () => {
    indexer.updateSettings({ ...settings, excludeWorkspaces: ['sample-app'] });
    const s = await indexer.scan();
    expect(s.removedFiles).toBe(2);
    expect(db.sessionMeta(LEGACY_KEY)).toBeUndefined();
    expect(db.sessionMeta(MAIN_KEY)?.workspaceId).toBe(`vscode:${WS_FILE_HASH}`);
    expect(db.workspaces().map((w) => w.id)).not.toContain(`vscode:${WS_FOLDER_HASH}`);
  });

  it('re-parses files written by an older parser version (R4.7)', async () => {
    db.store.run('UPDATE files SET parser_version = 0');
    db.store.run('UPDATE workspaces SET fingerprint = NULL');
    const s = await indexer.scan();
    expect(s.parsed).toBe(4);
  });

  it('marks broken files failed and recovers on change (R3.5)', async () => {
    const bad = path.join(chat(WS_FOLDER_HASH), 'broken.jsonl');
    fs.writeFileSync(bad, '{"kind":0,');
    let s = await indexer.scan();
    expect(s.failed).toBe(1);
    expect(db.file(bad)).toMatchObject({ status: 'failed', error: 'unparseable' });
    expect(db.summary().failedFiles).toBe(1);
    fs.writeFileSync(bad, '');
    s = await indexer.scan();
    expect(db.file(bad)?.status).toBe('empty');
    expect(s.empty).toBe(1);
  });

  it('demotes a winner that becomes empty and promotes its copy', async () => {
    const winner = db.sessionFile(MAIN_KEY)!;
    fs.writeFileSync(winner, '');
    await indexer.scan();
    expect(db.file(winner)?.status).toBe('empty');
    expect(db.sessionFile(MAIN_KEY)).not.toBe(winner);
  });

  it('throttles a file re-indexed within 10 s (R5.15)', async () => {
    let now = 1_000_000;
    const throttled = new Indexer(db, settings, { now: () => now });
    const file = path.join(chat(WS_FOLDER_HASH), `${LEGACY_ID}.json`);
    fs.appendFileSync(file, ' ');
    expect((await throttled.scan({ throttle: true })).parsed).toBe(1);
    fs.appendFileSync(file, ' ');
    now += 1_000;
    const s = await throttled.scan({ throttle: true });
    expect(s).toMatchObject({ parsed: 0, deferred: 1, retryAt: 1_000_000 + THROTTLE_MS });
    now += THROTTLE_MS;
    expect((await throttled.scan({ throttle: true })).parsed).toBe(1);
  });

  it('re-flags noise and titles when noisePatterns change (R5.17)', () => {
    indexer.updateSettings({ ...settings, noisePatterns: ['explain the sample build script\\.'] });
    expect(indexer.reflagNoiseIfNeeded()).toBe(true);
    expect(indexer.reflagNoiseIfNeeded()).toBe(false);
    const m = db.sessionMeta(LEGACY_KEY)!;
    expect(m.noisePromptCount).toBe(1);
    expect(m.title).toBe('');
    expect(match(db, '{title}: explain')).toEqual([]);
    expect(match(db, '{prompt}: explain')).toEqual([{ key: LEGACY_KEY, idx: 0 }]);
    expect(db.sessionMeta(MAIN_KEY)?.title).toBe('Sample parser refactoring');
  });

  it('honours cancellation and cleans up a cancelled cold build', async () => {
    fs.utimesSync(db.sessionFile(LEGACY_KEY)!, new Date(), new Date(Date.now() + 5000));
    await expect(indexer.scan({ token: { cancelled: true } })).rejects.toBeInstanceOf(CancelledError);
    const d2 = tempDir();
    await expect(coldBuild(indexPaths(d2), settings, {}, { cancelled: true })).rejects.toBeInstanceOf(CancelledError);
    expect(fs.existsSync(indexPaths(d2).build)).toBe(false);
    expect(fs.existsSync(indexPaths(d2).live)).toBe(false);
  });

  it('reports progress and the file being parsed', async () => {
    const parsing: string[] = [];
    const progress: [number, number][] = [];
    const s = await new Indexer(db, settings, { onParsing: (p) => parsing.push(p), onProgress: (d, t) => progress.push([d, t]) }).scan({ force: true });
    expect(parsing).toHaveLength(s.parsed);
    expect(progress.at(-1)).toEqual([4, 4]);
  });
});
