import fs from 'node:fs';
import { type ParsedSession, sessionKey } from '../core/model';
import { SessionParseError } from '../core/parser-vscode';
import { combinedParserVersion, parserFor } from '../core/parsers';
import { type DiscoveredFile, type DiscoveredWorkspace, discoverWorkspaces, type PlatformEnv, resolveRoots, type SourceSettings } from '../core/sources';
import { createNoiseMatcher } from '../core/text';
import { type FileRow, type FileStatus, IndexDb } from '../store/index-db';
import { openNodeSqliteStore, publishBuild } from '../store/node-sqlite-store';
import { type IndexConfig, indexConfigValue, META, SCHEMA_VERSION } from '../store/schema';

/** Incremental indexer (SPEC §5.5). Runs inside the worker; pure Node, so it is unit-tested in-process. */

export interface IndexerSettings extends SourceSettings, IndexConfig {
  noisePatterns: readonly string[];
}

export interface CancelToken {
  readonly cancelled: boolean;
}

export class CancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelledError';
  }
}

export interface IndexerHooks {
  onProgress?: (done: number, total: number) => void;
  /** Called before each file is parsed (R5.18: the host marks it failed if the worker dies). */
  onParsing?: (path: string) => void;
  /** Pattern strings only; never file content. */
  onInvalidNoisePattern?: (pattern: string) => void;
  now?: () => number;
  env?: PlatformEnv;
}

export interface ScanStats {
  workspaces: number;
  changedWorkspaces: number;
  files: number;
  parsed: number;
  sessionsWritten: number;
  turnsWritten: number;
  removedFiles: number;
  failed: number;
  empty: number;
  duplicates: number;
  deferred: number;
  /** Earliest time a throttled file may be re-indexed (R5.15). */
  retryAt?: number;
  durationMs: number;
}

export const BATCH_SESSIONS = 250;
const BATCH_CHARS = 32 * 1024 * 1024;
export const THROTTLE_MS = 10_000;

type Outcome = { kind: 'ok'; parsed: ParsedSession } | { kind: 'empty' } | { kind: 'failed'; error: string };

const better = (a: { mtime: number; path: string }, b: { mtime: number; path: string }): boolean =>
  a.mtime > b.mtime || (a.mtime === b.mtime && a.path < b.path);

function errorCode(e: unknown): string {
  if (e instanceof SessionParseError) return e.reason;
  if (e && typeof e === 'object' && 'code' in e && typeof e.code === 'string') return e.code;
  return 'error';
}

export class Indexer {
  private readonly lastIndexed = new Map<string, number>();
  private readonly parserVersion = combinedParserVersion();
  private isNoise: (p: string) => boolean;

  constructor(
    readonly db: IndexDb,
    private settings: IndexerSettings,
    private readonly hooks: IndexerHooks = {},
  ) {
    this.isNoise = createNoiseMatcher(settings.noisePatterns, hooks.onInvalidNoisePattern);
  }

  private now(): number {
    return this.hooks.now?.() ?? Date.now();
  }

  updateSettings(settings: IndexerSettings): void {
    this.settings = settings;
    this.isNoise = createNoiseMatcher(settings.noisePatterns, this.hooks.onInvalidNoisePattern);
  }

  /** R5.17 – re-flags noise when `noisePatterns` changed since the index was written. Returns true if it ran. */
  reflagNoiseIfNeeded(): boolean {
    const value = JSON.stringify(this.settings.noisePatterns);
    if (this.db.getMeta(META.noisePatterns) === value) return false;
    this.db.store.transaction(() => {
      this.db.reflagNoise(this.isNoise);
      this.db.setMeta(META.noisePatterns, value);
    });
    return true;
  }

  async scan(opts: { force?: boolean; throttle?: boolean; token?: CancelToken } = {}): Promise<ScanStats> {
    const t0 = performance.now();
    const db = this.db;
    const stats: ScanStats = { workspaces: 0, changedWorkspaces: 0, files: 0, parsed: 0, sessionsWritten: 0, turnsWritten: 0, removedFiles: 0, failed: 0, empty: 0, duplicates: 0, deferred: 0, durationMs: 0 };
    const discovered = await discoverWorkspaces(resolveRoots(this.settings, this.hooks.env), this.settings);
    this.checkCancel(opts.token);
    const known = new Map(db.workspaces().map((w) => [w.id, w]));
    const changed: DiscoveredWorkspace[] = [];
    const byPath = new Map<string, DiscoveredFile>();
    stats.workspaces = discovered.length;
    db.store.transaction(() => {
      for (const ws of discovered) {
        db.upsertWorkspace(ws);
        for (const f of ws.files) byPath.set(f.path, f);
        stats.files += ws.files.length;
        if (opts.force || known.get(ws.id)?.fingerprint !== ws.fingerprint) changed.push(ws);
      }
    });
    stats.changedWorkspaces = changed.length;

    const removals: string[] = [];
    const goneWorkspaces: string[] = [];
    const seenIds = new Set(discovered.map((w) => w.id));
    for (const id of known.keys()) {
      if (seenIds.has(id)) continue;
      goneWorkspaces.push(id);
      removals.push(...db.filesOfWorkspace(id).map((f) => f.path));
    }

    const queue: DiscoveredFile[] = [];
    const queued = new Set<string>();
    const enqueue = (f: DiscoveredFile | undefined): void => {
      if (f && !queued.has(f.path)) {
        queued.add(f.path);
        queue.push(f);
      }
    };
    const deferredWorkspaces = new Set<string>();
    const now = this.now();
    for (const ws of changed) {
      const rows = new Map(db.filesOfWorkspace(ws.id).map((r) => [r.path, r]));
      for (const f of ws.files) {
        const r = rows.get(f.path);
        rows.delete(f.path);
        if (!opts.force && r && r.mtime === f.mtimeMs && r.size === f.size && r.parser_version === this.parserVersion) continue;
        const last = this.lastIndexed.get(f.path);
        if (opts.throttle && last !== undefined && now - last < THROTTLE_MS) {
          stats.deferred++;
          deferredWorkspaces.add(ws.id);
          stats.retryAt = Math.min(stats.retryAt ?? Number.POSITIVE_INFINITY, last + THROTTLE_MS);
          continue;
        }
        enqueue(f);
      }
      removals.push(...rows.keys());
    }

    db.store.transaction(() => {
      for (const p of removals) for (const promoted of this.removeFile(p)) enqueue(byPath.get(promoted));
      for (const id of goneWorkspaces) db.deleteWorkspace(id);
    });
    stats.removedFiles = removals.length;

    let batch: { f: DiscoveredFile; outcome: Outcome }[] = [];
    let batchChars = 0;
    const flush = (): void => {
      if (!batch.length) return;
      const items = batch;
      batch = [];
      batchChars = 0;
      db.store.transaction(() => {
        for (const { f, outcome } of items) for (const promoted of this.apply(f, outcome, stats)) enqueue(byPath.get(promoted));
      });
    };
    for (let i = 0; i < queue.length; i++) {
      this.checkCancel(opts.token);
      const f = queue[i]!;
      this.hooks.onProgress?.(i, queue.length);
      this.hooks.onParsing?.(f.path);
      const outcome = await this.parse(f);
      this.lastIndexed.set(f.path, this.now());
      stats.parsed++;
      batch.push({ f, outcome });
      if (outcome.kind === 'ok') batchChars += outcome.parsed.turns.reduce((n, t) => n + t.prompt.length + t.response.length + t.thinking.length, 0);
      if (batch.length >= BATCH_SESSIONS || batchChars >= BATCH_CHARS) flush();
    }
    flush();
    this.hooks.onProgress?.(queue.length, queue.length);

    db.store.transaction(() => {
      for (const ws of changed) if (!deferredWorkspaces.has(ws.id)) db.setWorkspaceFingerprint(ws.id, ws.fingerprint);
    });
    stats.durationMs = performance.now() - t0;
    return stats;
  }

  private checkCancel(token: CancelToken | undefined): void {
    if (token?.cancelled) throw new CancelledError();
  }

  private async parse(f: DiscoveredFile): Promise<Outcome> {
    const parser = parserFor(f);
    if (!parser) return { kind: 'failed', error: 'no-parser' };
    try {
      const parsed = await parser.parse(f, { maxFieldChars: this.settings.maxTurnTextKB * 1024, isNoise: this.isNoise });
      return parsed && parsed.turns.length > 0 ? { kind: 'ok', parsed } : { kind: 'empty' };
    } catch (e) {
      return { kind: 'failed', error: errorCode(e) };
    }
  }

  private fileRow(f: DiscoveredFile, status: FileStatus, key: string | null, error: string | null = null): FileRow {
    return { path: f.path, source: f.source, workspace_id: f.workspaceId, mtime: f.mtimeMs, size: f.size, parser_version: this.parserVersion, session_key: key, status, error };
  }

  /** Writes one parse outcome; returns paths of duplicate copies that must be (re)parsed to be promoted. */
  private apply(f: DiscoveredFile, outcome: Outcome, stats: ScanStats): string[] {
    const db = this.db;
    const prev = db.file(f.path);
    const promote: string[] = [];
    const wasWinnerOf = prev?.status === 'ok' ? prev.session_key : null;
    if (outcome.kind !== 'ok') {
      if (wasWinnerOf) promote.push(...this.dropWinner(wasWinnerOf, f.path));
      db.upsertFile(this.fileRow(f, outcome.kind, null, outcome.kind === 'failed' ? outcome.error : null));
      if (outcome.kind === 'failed') stats.failed++;
      else stats.empty++;
      return promote;
    }
    const key = sessionKey(f.source, outcome.parsed.id);
    if (wasWinnerOf && wasWinnerOf !== key) promote.push(...this.dropWinner(wasWinnerOf, f.path));
    const currentPath = db.sessionFile(key);
    const current = currentPath && currentPath !== f.path ? db.file(currentPath) : undefined;
    if (current && !better({ mtime: f.mtimeMs, path: f.path }, current)) {
      db.upsertFile(this.fileRow(f, 'duplicate', key));
      stats.duplicates++;
      return promote;
    }
    stats.turnsWritten += db.writeSession(key, outcome.parsed, f, this.settings);
    stats.sessionsWritten++;
    db.upsertFile(this.fileRow(f, 'ok', key));
    if (current) {
      db.setFileStatus(current.path, 'duplicate', key);
      stats.duplicates++;
    }
    return promote;
  }

  /** The winning copy of `key` went away: delete the session and return the best remaining copy (R5.19). */
  private dropWinner(key: string, exceptPath: string): string[] {
    this.db.deleteSession(key);
    let best: FileRow | undefined;
    for (const r of this.db.filesOfSession(key)) {
      if (r.path === exceptPath || r.status !== 'duplicate') continue;
      if (!best || better(r, best)) best = r;
    }
    if (!best) return [];
    this.db.setFileStatus(best.path, 'duplicate', null);
    return [best.path];
  }

  private removeFile(path: string): string[] {
    const prev = this.db.file(path);
    this.db.deleteFile(path);
    return prev?.status === 'ok' && prev.session_key ? this.dropWinner(prev.session_key, path) : [];
  }
}

/** Why the live index must be rebuilt (R5.17), or null when it is current. */
export function rebuildReason(db: IndexDb, config: IndexConfig): string | null {
  const schema = db.getMeta(META.schemaVersion);
  if (schema === undefined) return 'missing';
  if (schema !== String(SCHEMA_VERSION)) return 'schema-version';
  if (db.getMeta(META.parserVersion) !== String(combinedParserVersion())) return 'parser-version';
  if (db.getMeta(META.indexConfig) !== indexConfigValue(config)) return 'index-config';
  return null;
}

export interface IndexPaths {
  dir: string;
  live: string;
  build: string;
  lock: string;
}

export function indexPaths(dir: string): IndexPaths {
  return { dir, live: `${dir}/index.sqlite`, build: `${dir}/index.sqlite.build`, lock: `${dir}/index.lock` };
}

/** R5.4 – cold build into `index.sqlite.build`, then publish atomically into `index.sqlite`. */
export async function coldBuild(paths: IndexPaths, settings: IndexerSettings, hooks: IndexerHooks = {}, token?: CancelToken): Promise<ScanStats> {
  fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  for (const suffix of ['', '-journal', '-wal', '-shm']) fs.rmSync(paths.build + suffix, { force: true });
  const store = openNodeSqliteStore(paths.build, { journal: 'delete' });
  let stats: ScanStats;
  try {
    const db = new IndexDb(store);
    db.createSchema({ parserVersion: combinedParserVersion(), config: settings, noisePatterns: settings.noisePatterns });
    stats = await new Indexer(db, settings, hooks).scan({ force: true, token });
    db.optimize();
    db.setMeta(META.builtAt, String(Date.now()));
  } catch (e) {
    store.close();
    fs.rmSync(paths.build, { force: true });
    throw e;
  }
  store.close();
  await publishBuild(paths.build, paths.live);
  return stats;
}
