import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import { EMPTY_WINDOW, type SourceId, workspaceKey } from '../core/ids';
import { folderKey } from '../core/folders';
import { resolveCliRoots, resolveRoots } from '../core/sources';
import type { SearchRequest, SearchResponse } from '../query/engine';
import type { Facets, IndexSummary, SessionListItem } from '../store/index-db';
import type { CurrentWorkspace } from '../ui/tree-model';
import { IndexLock, LOCK_HEARTBEAT_MS } from '../store/lock';
import type { SessionMeta } from '../core/model';
import type { IndexerSettings } from '../worker/indexer';
import type { ListFilter, LoadedSession, SyncResult, WorkerEvent } from '../worker/protocol';
import { indexerSettings, INDEX_SETTINGS, uiSettings } from './config';
import { RpcCancelledError, WorkerClient, type WorkerCrashedError } from './worker-client';

/** Orchestrates the index worker, the single-writer role (R5.3), file watching (R5.14) and status (R7.7, R7.26). */

export type IndexState = 'starting' | 'indexing' | 'idle' | 'waiting' | 'deleted' | 'error';

export interface IndexStatus {
  state: IndexState;
  role: 'writer' | 'reader';
  done: number;
  total: number;
  failedFiles: number;
  sessions: number;
}

/** The current window: source app and workspace id (R7.4), plus where its own chat sessions live (R8.1). */
export interface CurrentWindow {
  source: Extract<SourceId, 'vscode' | 'vscode-insiders'>;
  workspaceId: string;
  /** `<workspaceStorage>/<hash>/chatSessions`, or `<globalStorage>/emptyWindowChatSessions` in an empty window. */
  chatSessionsDir: string;
  isEmptyWindow: boolean;
  /** Folder key (R5.21) of this window's `.code-workspace` file or single folder, for the current folder group (R7.4). */
  folder?: string;
}

function currentFolderKey(): string | undefined {
  const file = vscode.workspace.workspaceFile;
  if (file) return file.scheme === 'untitled' ? undefined : folderKey(file.toString());
  const folders = vscode.workspace.workspaceFolders;
  return folders?.length === 1 ? folderKey(folders[0]!.uri.toString()) : undefined;
}

export function currentWindow(context: vscode.ExtensionContext): CurrentWindow {
  const source = /insiders/i.test(vscode.env.appName) ? 'vscode-insiders' : 'vscode';
  if (context.storageUri) {
    const storageDir = path.dirname(context.storageUri.fsPath);
    return { source, workspaceId: workspaceKey(source, path.basename(storageDir)), chatSessionsDir: path.join(storageDir, 'chatSessions'), isEmptyWindow: false, folder: currentFolderKey() };
  }
  const globalStorage = path.dirname(context.globalStorageUri.fsPath);
  return { source, workspaceId: workspaceKey(source, EMPTY_WINDOW), chatSessionsDir: path.join(globalStorage, 'emptyWindowChatSessions'), isEmptyWindow: true };
}

const READER_POLL_MS = 5_000;
const WATCH_DEBOUNCE_MS = 2_000;

export class SearchieService implements vscode.Disposable {
  readonly dir: string;
  readonly window: CurrentWindow;
  private readonly lock: IndexLock;
  private readonly deletedMarker: string;
  private client: WorkerClient;
  private settings: IndexerSettings;
  private ready: Promise<void> | undefined;
  private status: IndexStatus = { state: 'starting', role: 'reader', done: 0, total: 0, failedFiles: 0, sessions: 0 };
  private lastDataVersion = -2;
  private ticks = 0;
  private syncing = false;
  private syncAgain: { throttle: boolean } | undefined;
  private readonly timers: NodeJS.Timeout[] = [];
  private retryTimer: NodeJS.Timeout | undefined;
  private watchTimer: NodeJS.Timeout | undefined;
  private watchers: vscode.Disposable[] = [];
  private pollTimer: NodeJS.Timeout | undefined;
  private changeTimer: NodeJS.Timeout | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly onDidChangeIndexEmitter = new vscode.EventEmitter<void>();
  private readonly onDidChangeStatusEmitter = new vscode.EventEmitter<IndexStatus>();
  readonly onDidChangeIndex = this.onDidChangeIndexEmitter.event;
  readonly onDidChangeStatus = this.onDidChangeStatusEmitter.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    readonly log: vscode.LogOutputChannel,
  ) {
    this.dir = context.globalStorageUri.fsPath;
    this.window = currentWindow(context);
    this.lock = new IndexLock(path.join(this.dir, 'index.lock'));
    this.deletedMarker = path.join(this.dir, 'index.deleted');
    this.settings = indexerSettings();
    this.client = this.newClient();
    this.disposables.push(
      this.onDidChangeIndexEmitter,
      this.onDidChangeStatusEmitter,
      vscode.workspace.onDidChangeConfiguration((e) => this.onConfigChanged(e)),
    );
  }

  private newClient(): WorkerClient {
    return new WorkerClient(
      this.context.asAbsolutePath(path.join('dist', 'worker.js')),
      (e) => this.onWorkerEvent(e),
      (e) => void this.onWorkerCrash(e),
    );
  }

  /** Starts the worker and the first sync in the background (R5.13: the UI is usable with stale data). */
  start(): Promise<void> {
    this.ready ??= this.init();
    return this.ready;
  }

  private async init(): Promise<void> {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const writer = this.lock.tryAcquire();
    const st = await this.client.call('init', { dir: this.dir, settings: this.settings, writer });
    this.setStatus({ role: st.role, state: st.hasIndex ? 'idle' : 'waiting' });
    this.log.info(`started as ${st.role} (index ${st.hasIndex ? 'present' : 'missing'})`);
    this.timers.push(setInterval(() => void this.tick(), READER_POLL_MS));
    this.updateWatchers();
    this.updatePoll();
    await this.refreshSummary();
    if (writer) void this.sync('startup', { throttle: false });
  }

  get currentStatus(): IndexStatus {
    return this.status;
  }

  private setStatus(patch: Partial<IndexStatus>): void {
    this.status = { ...this.status, ...patch };
    this.onDidChangeStatusEmitter.fire(this.status);
  }

  private fireChanged(): void {
    if (this.changeTimer) clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => {
      this.changeTimer = undefined;
      void this.refreshSummary();
      this.onDidChangeIndexEmitter.fire();
    }, 300);
  }

  private onWorkerEvent(e: WorkerEvent): void {
    if (e.event === 'progress') this.setStatus({ state: e.done < e.total ? 'indexing' : this.status.state, done: e.done, total: e.total });
    else if (e.event === 'changed') this.fireChanged();
    else if (e.event === 'log') this.log[e.level](e.message);
  }

  /** R5.18 – a crashed worker (e.g. out of memory) marks the file it was parsing as failed and is restarted. */
  private async onWorkerCrash(e: WorkerCrashedError): Promise<void> {
    this.log.error(`index worker stopped (${e.code}); restarting`);
    this.client = this.newClient();
    try {
      const st = await this.client.call('init', { dir: this.dir, settings: this.settings, writer: this.lock.isHeld });
      this.setStatus({ role: st.role, state: 'error' });
      if (e.lastParsing && this.lock.isHeld) await this.client.call('markFailed', { path: e.lastParsing, error: e.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'out-of-memory' : 'worker-crash' });
      this.syncing = false;
      if (this.lock.isHeld) void this.sync('restart', { throttle: false });
    } catch (err) {
      this.log.error(`worker restart failed (${(err as Error).name})`);
    }
  }

  private async tick(): Promise<void> {
    this.ticks++;
    try {
      if (this.isDeleted() && this.status.state !== 'deleted' && !this.syncing) {
        await this.client.call('deleteIndex', {});
        this.setStatus({ state: 'deleted', sessions: 0, failedFiles: 0 });
        this.fireChanged();
        return;
      }
      if (this.ticks % Math.round(LOCK_HEARTBEAT_MS / READER_POLL_MS) === 0) await this.checkRole();
      if (!this.lock.isHeld) {
        let st = await this.client.call('status', {});
        if (!st.hasIndex && fs.existsSync(path.join(this.dir, 'index.sqlite'))) {
          await this.client.call('sync', {});
          st = await this.client.call('status', {});
        }
        if (st.dataVersion !== this.lastDataVersion) {
          this.lastDataVersion = st.dataVersion;
          this.setStatus({ state: st.hasIndex ? 'idle' : this.isDeleted() ? 'deleted' : 'waiting' });
          this.fireChanged();
        }
      }
    } catch (e) {
      if (!(e instanceof RpcCancelledError)) this.log.warn(`status poll failed (${(e as Error).name})`);
    }
  }

  /** Heartbeat as writer; as reader, take over a stale lock (R5.3). */
  private async checkRole(): Promise<void> {
    if (this.lock.isHeld) {
      if (this.lock.heartbeat()) return;
      this.log.info('lost the writer lock to another window; switching to reader');
      this.setStatus({ role: (await this.client.call('setRole', { writer: false })).role });
      return;
    }
    if (this.lock.tryAcquire()) {
      this.log.info('took over the writer lock');
      const st = await this.client.call('setRole', { writer: true });
      this.setStatus({ role: st.role });
      void this.sync('takeover', { throttle: false });
    }
  }

  isDeleted(): boolean {
    return fs.existsSync(this.deletedMarker);
  }

  /** Runs one incremental sync as writer; overlapping requests are coalesced. */
  async sync(reason: string, opts: { throttle: boolean; force?: boolean }): Promise<SyncResult | undefined> {
    await this.start();
    if (!this.lock.isHeld) return undefined;
    if (this.isDeleted()) {
      if (reason !== 'manual') {
        this.setStatus({ state: 'deleted' });
        return undefined;
      }
      fs.rmSync(this.deletedMarker, { force: true });
    }
    if (this.syncing) {
      this.syncAgain = { throttle: (this.syncAgain?.throttle ?? true) && opts.throttle };
      return undefined;
    }
    this.syncing = true;
    this.setStatus({ state: 'indexing', done: 0, total: 0 });
    try {
      const r = await this.client.call('sync', { throttle: opts.throttle, force: opts.force });
      const s = r.stats;
      if (s) {
        this.log.info(
          `sync (${reason})${r.rebuilt ? ` rebuilt: ${r.rebuilt}` : ''}: ${s.changedWorkspaces}/${s.workspaces} workspaces changed, ${s.parsed} parsed, ${s.sessionsWritten} sessions written, ${s.removedFiles} removed, ${s.failed} failed, ${s.deferred} deferred, ${Math.round(s.durationMs)} ms`,
        );
        if (s.retryAt) this.scheduleRetry(s.retryAt);
      }
      this.setStatus({ state: 'idle' });
      await this.refreshSummary();
      return r;
    } catch (e) {
      if (!(e instanceof RpcCancelledError)) {
        this.log.error(`sync failed (${(e as Error).name})`);
        this.setStatus({ state: 'error' });
      }
      return undefined;
    } finally {
      this.syncing = false;
      const again = this.syncAgain;
      this.syncAgain = undefined;
      if (again) void this.sync('coalesced', again);
    }
  }

  async rebuild(): Promise<void> {
    await this.start();
    if (!this.lock.isHeld) {
      void vscode.window.showInformationMessage('Searchie: another VS Code window is maintaining the index. Run Rebuild Index there, or close it first.');
      return;
    }
    fs.rmSync(this.deletedMarker, { force: true });
    this.setStatus({ state: 'indexing', done: 0, total: 0 });
    try {
      const r = await this.client.call('rebuild', {});
      this.log.info(`rebuild: ${r.stats?.sessionsWritten ?? 0} sessions, ${r.stats?.turnsWritten ?? 0} turns, ${Math.round(r.stats?.durationMs ?? 0)} ms`);
      this.setStatus({ state: 'idle' });
    } catch (e) {
      this.log.error(`rebuild failed (${(e as Error).name})`);
      this.setStatus({ state: 'error' });
    }
    await this.refreshSummary();
    this.fireChanged();
  }

  /** R10.3 – removes the index and pauses indexing in all windows until Refresh or Rebuild. */
  async deleteIndex(): Promise<void> {
    await this.start();
    fs.writeFileSync(this.deletedMarker, '', { mode: 0o600 });
    try {
      await this.client.call('deleteIndex', {});
      for (const f of fs.readdirSync(this.dir)) {
        if (f.startsWith('index.sqlite') || f === 'pending-open.json') fs.rmSync(path.join(this.dir, f), { force: true });
      }
      this.log.info('index deleted');
      this.setStatus({ state: 'deleted', sessions: 0, failedFiles: 0 });
      this.fireChanged();
      void vscode.window.showInformationMessage('Searchie: index deleted. Indexing is paused until you run Refresh Index or Rebuild Index.');
    } catch (e) {
      this.log.error(`delete failed (${(e as NodeJS.ErrnoException).code ?? (e as Error).name})`);
      void vscode.window.showErrorMessage('Searchie: the index could not be deleted completely. Close other VS Code windows and try again.');
    }
  }

  private scheduleRetry(at: number): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.sync('throttled', { throttle: true }), Math.max(500, at - Date.now() + 100));
  }

  /** R5.14 / R5.22 – watch every source root; changes are debounced (2 s) and throttled per file in the worker (R5.15). */
  private updateWatchers(): void {
    for (const w of this.watchers) w.dispose();
    this.watchers = [];
    const pattern = '{workspaceStorage/*/chatSessions/*.{jsonl,json},globalStorage/emptyWindowChatSessions/*.{jsonl,json}}';
    for (const root of resolveRoots(this.settings)) {
      if (!fs.existsSync(root.userDir)) continue;
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(root.userDir), pattern));
      const onChange = (): void => this.onSourceChanged();
      this.watchers.push(watcher, watcher.onDidChange(onChange), watcher.onDidCreate(onChange), watcher.onDidDelete(onChange));
    }
    for (const root of resolveCliRoots(this.settings)) {
      if (!fs.existsSync(root.dir)) continue;
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(root.dir), '*/{events.jsonl,workspace.yaml}'));
      const onChange = (): void => this.onSourceChanged();
      this.watchers.push(watcher, watcher.onDidChange(onChange), watcher.onDidCreate(onChange), watcher.onDidDelete(onChange));
    }
  }

  private onSourceChanged(): void {
    if (!this.lock.isHeld) return;
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = setTimeout(() => void this.sync('watcher', { throttle: true }), WATCH_DEBOUNCE_MS);
  }

  private updatePoll(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    const minutes = uiSettings().pollIntervalMinutes;
    if (minutes > 0) this.pollTimer = setInterval(() => void this.sync('poll', { throttle: true }), minutes * 60_000);
  }

  private onConfigChanged(e: vscode.ConfigurationChangeEvent): void {
    if (e.affectsConfiguration('searchie.index.pollIntervalMinutes')) this.updatePoll();
    if (!INDEX_SETTINGS.some((s) => e.affectsConfiguration(s))) {
      if (e.affectsConfiguration('searchie')) this.onDidChangeIndexEmitter.fire();
      return;
    }
    this.settings = indexerSettings();
    void (async () => {
      await this.start();
      await this.client.call('updateSettings', { settings: this.settings });
      this.updateWatchers();
      await this.sync('settings', { throttle: false });
      this.fireChanged();
    })();
  }

  private async refreshSummary(): Promise<void> {
    try {
      const s = await this.client.call('summary', {});
      this.setStatus({ failedFiles: s.failedFiles, sessions: s.sessions });
    } catch {
      // worker restarting
    }
  }

  // ------------------------------------------------------------ queries

  async listSessions(filter: ListFilter): Promise<SessionListItem[]> {
    await this.start();
    return this.client.call('listSessions', filter);
  }

  async sessionMeta(key: string): Promise<SessionMeta | undefined> {
    await this.start();
    return (await this.client.call('sessionMeta', { key })) ?? undefined;
  }

  async summary(): Promise<IndexSummary> {
    await this.start();
    return this.client.call('summary', {});
  }

  async facets(): Promise<Facets> {
    await this.start();
    return this.client.call('facets', {});
  }

  async search(req: SearchRequest, token?: vscode.CancellationToken): Promise<SearchResponse> {
    await this.start();
    const ui = uiSettings();
    return this.client.call('search', { recencyBoost: ui.recencyBoost, weights: ui.weights, redact: ui.redactSecrets, limit: ui.maxResults, autoFuzzy: ui.autoFuzzy, ...req }, token);
  }

  async loadSession(key: string): Promise<LoadedSession | null> {
    await this.start();
    return this.client.call('loadSession', { key });
  }

  /** "This window" for the tree (R7.4): its workspace id and folder key; the current group is the folder group containing it. */
  currentWorkspace(): CurrentWorkspace {
    return { ids: new Set([this.window.workspaceId]), folder: this.window.folder };
  }

  dispose(): void {
    for (const t of this.timers) clearInterval(t);
    for (const t of [this.retryTimer, this.watchTimer, this.changeTimer]) if (t) clearTimeout(t);
    if (this.pollTimer) clearInterval(this.pollTimer);
    for (const w of this.watchers) w.dispose();
    for (const d of this.disposables) d.dispose();
    this.lock.release();
    void this.client.dispose();
  }
}
