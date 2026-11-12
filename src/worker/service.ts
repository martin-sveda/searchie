import fs from 'node:fs';
import { QueryEngine, type SearchRequest, type SearchResponse } from '../query/engine';
import { type StatsFilter, type StatsResult, StatsEngine } from '../query/stats';
import { IndexDb } from '../store/index-db';
import { openNodeSqliteStore } from '../store/node-sqlite-store';
import { CancelledError, type CancelToken, coldBuild, Indexer, type IndexerSettings, type IndexPaths, indexPaths, rebuildReason } from './indexer';
import { parserFor } from '../core/parsers';
import { createNoiseMatcher } from '../core/text';
import { type ListFilter, type LoadedSession, PREVIEW_MAX_FIELD_CHARS, type SyncResult, type WorkerEvent, type WorkerStatus } from './protocol';

/** Worker-side state: owns the index connection and the indexer. Methods mirror `WorkerMethods`. */
export class WorkerService {
  private paths?: IndexPaths;
  private settings?: IndexerSettings;
  private writer = false;
  private db?: IndexDb;
  private indexer?: Indexer;
  private syncing?: Promise<SyncResult>;
  private engine?: QueryEngine;
  private stats?: StatsEngine;

  constructor(private readonly emit: (e: WorkerEvent) => void) {}

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    this.emit({ event: 'log', level, message });
  }

  init(p: { dir: string; settings: IndexerSettings; writer: boolean }): WorkerStatus {
    this.paths = indexPaths(p.dir);
    this.settings = p.settings;
    fs.mkdirSync(p.dir, { recursive: true, mode: 0o700 });
    this.writer = p.writer;
    this.open();
    return this.status();
  }

  setRole(p: { writer: boolean }): WorkerStatus {
    if (this.db && this.writer === p.writer) return this.status();
    this.writer = p.writer;
    this.open();
    return this.status();
  }

  updateSettings(p: { settings: IndexerSettings }): void {
    this.settings = p.settings;
    this.indexer?.updateSettings(p.settings);
  }

  private open(): void {
    this.closeDb();
    const paths = this.requirePaths();
    // Only an existing index is opened; a writer creates it with a cold build (published by rename).
    if (!fs.existsSync(paths.live)) return;
    try {
      this.db = new IndexDb(openNodeSqliteStore(paths.live, { readOnly: !this.writer }));
      this.engine = new QueryEngine(this.db.store);
      this.stats = new StatsEngine(this.db.store);
      if (this.writer) this.indexer = new Indexer(this.db, this.requireSettings(), this.hooks());
    } catch (e) {
      this.log('warn', `index open failed (${(e as Error).name}: ${(e as Error).message})`);
      this.closeDb();
    }
  }

  private closeDb(): void {
    this.db?.store.close();
    this.db = undefined;
    this.engine = undefined;
    this.stats = undefined;
    this.indexer = undefined;
  }

  private hooks(): ConstructorParameters<typeof Indexer>[2] {
    return {
      onProgress: (done, total) => this.emit({ event: 'progress', done, total }),
      onParsing: (path) => this.emit({ event: 'parsing', path }),
      onInvalidNoisePattern: () => this.log('warn', 'ignored an invalid searchie.noisePatterns entry'),
    };
  }

  private requirePaths(): IndexPaths {
    if (!this.paths) throw new Error('worker not initialised');
    return this.paths;
  }

  private requireSettings(): IndexerSettings {
    if (!this.settings) throw new Error('worker not initialised');
    return this.settings;
  }

  status(): WorkerStatus {
    let dataVersion: number;
    try {
      dataVersion = this.db?.store.dataVersion() ?? 0;
    } catch {
      dataVersion = -1;
    }
    return { role: this.writer ? 'writer' : 'reader', hasIndex: this.db !== undefined, dataVersion };
  }

  sync(p: { force?: boolean; throttle?: boolean }, token?: CancelToken): Promise<SyncResult> {
    // Overlapping sync requests share the running one.
    this.syncing ??= this.doSync(p, token).finally(() => {
      this.syncing = undefined;
    });
    return this.syncing;
  }

  rebuild(token?: CancelToken): Promise<SyncResult> {
    return this.doSync({ rebuild: true }, token);
  }

  private async doSync(p: { force?: boolean; throttle?: boolean; rebuild?: boolean }, token?: CancelToken): Promise<SyncResult> {
    if (!this.writer) {
      this.open();
      return { role: 'reader', rebuilt: null, stats: null, noiseReflagged: false };
    }
    const settings = this.requireSettings();
    const reason = p.rebuild ? 'requested' : this.db ? rebuildReason(this.db, settings) : 'missing';
    if (reason) {
      this.log('info', `cold build started (${reason})`);
      const stats = await coldBuild(this.requirePaths(), settings, this.hooks(), token);
      this.open();
      this.emit({ event: 'changed' });
      this.log('info', `cold build done: ${stats.sessionsWritten} sessions, ${stats.turnsWritten} turns, ${stats.failed} failed, ${Math.round(stats.durationMs)} ms`);
      return { role: 'writer', rebuilt: reason, stats, noiseReflagged: false };
    }
    const indexer = this.indexer!;
    const noiseReflagged = indexer.reflagNoiseIfNeeded();
    const stats = await indexer.scan({ force: p.force, throttle: p.throttle, token });
    if (noiseReflagged || stats.sessionsWritten > 0 || stats.removedFiles > 0 || stats.failed > 0 || stats.empty > 0) this.emit({ event: 'changed' });
    return { role: 'writer', rebuilt: null, stats, noiseReflagged };
  }

  markFailed(p: { path: string; error: string }): void {
    if (!this.writer || !this.db) return;
    const db = this.db;
    let st: fs.Stats | undefined;
    try {
      st = fs.statSync(p.path);
    } catch {
      return;
    }
    const prev = db.file(p.path);
    db.store.transaction(() => {
      if (prev?.status === 'ok' && prev.session_key) db.deleteSession(prev.session_key);
      db.upsertFile({
        path: p.path,
        source: prev?.source ?? 'vscode',
        workspace_id: prev?.workspace_id ?? '',
        mtime: Math.trunc(st.mtimeMs),
        size: st.size,
        parser_version: prev?.parser_version ?? 0,
        session_key: null,
        status: 'failed',
        error: p.error,
      });
    });
  }

  listSessions(p: ListFilter): ReturnType<IndexDb['listSessions']> {
    return this.db?.listSessions(p) ?? [];
  }

  sessionMeta(p: { key: string }): ReturnType<IndexDb['sessionMeta']> | null {
    return this.db?.sessionMeta(p.key) ?? null;
  }

  summary(): ReturnType<IndexDb['summary']> {
    return this.db?.summary() ?? { sessions: 0, prompts: 0, workspaces: 0, credits30d: null, failedFiles: 0 };
  }

  facets(): ReturnType<IndexDb['facets']> {
    return this.db?.facets() ?? { models: [], modes: [], sources: [], workspaces: [] };
  }

  search(p: SearchRequest, token?: CancelToken): SearchResponse {
    if (token?.cancelled) throw new CancelledError();
    if (!this.engine) return { results: [], total: 0, offset: 0, tookMs: 0, terms: [], warnings: [], mode: 'list', fuzzy: false };
    return this.engine.search(p);
  }

  /** R9.1 – all statistics widgets in one call; null without an index. */
  statistics(p: { filter: StatsFilter }, token?: CancelToken): StatsResult | null {
    if (token?.cancelled) throw new CancelledError();
    return this.stats?.compute(p.filter) ?? null;
  }

  async loadSession(p: { key: string }): Promise<LoadedSession | null> {
    const meta = this.db?.sessionMeta(p.key);
    if (!meta) return null;
    const settings = this.requireSettings();
    const isNoise = createNoiseMatcher(settings.noisePatterns);
    for (const filePath of [meta.filePath, ...meta.copies.map((c) => c.filePath)]) {
      if (!fs.existsSync(filePath)) continue;
      const kind = filePath.toLowerCase().endsWith('.json') ? 'json' : 'jsonl';
      const parser = parserFor({ path: filePath, source: meta.source, kind });
      if (!parser) return null;
      const parsed = await parser.parse({ path: filePath, source: meta.source, kind }, { maxFieldChars: PREVIEW_MAX_FIELD_CHARS, isNoise, withParts: true });
      if (parsed) return { meta, turns: parsed.turns };
    }
    return null;
  }

  /** R10.3 – closes the connection and removes the index files; throws if a file can't be removed (e.g. Windows EBUSY). */
  deleteIndex(): void {
    this.closeDb();
    const p = this.requirePaths();
    for (const f of [p.live, `${p.live}-wal`, `${p.live}-shm`, `${p.live}-journal`, p.build, `${p.build}-journal`]) fs.rmSync(f, { force: true });
  }

  /** The live index database, for in-process query engines (M4). */
  get index(): IndexDb | undefined {
    return this.db;
  }

  close(): void {
    this.closeDb();
  }
}
