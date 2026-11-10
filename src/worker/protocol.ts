import type { SessionMeta } from '../core/model';
import type { SearchRequest, SearchResponse } from '../query/engine';
import type { IndexSummary, SessionListItem } from '../store/index-db';
import type { ScanStats, IndexerSettings } from './indexer';

/** Typed host ↔ worker protocol. Each method maps params → result. */

export interface ListFilter {
  workspaceId?: string;
  sources?: string[];
  models?: string[];
  modes?: string[];
  after?: number;
  before?: number;
}

export interface SyncResult {
  role: 'writer' | 'reader';
  rebuilt: string | null;
  stats: ScanStats | null;
  noiseReflagged: boolean;
}

export interface WorkerStatus {
  role: 'writer' | 'reader';
  hasIndex: boolean;
  dataVersion: number;
}

export interface WorkerMethods {
  init(p: { dir: string; settings: IndexerSettings; writer: boolean }): WorkerStatus;
  setRole(p: { writer: boolean }): WorkerStatus;
  updateSettings(p: { settings: IndexerSettings }): void;
  /** Writer: rebuild if needed (R5.17), re-flag noise, incremental scan. Reader: reopen. */
  sync(p: { force?: boolean; throttle?: boolean }): SyncResult;
  rebuild(p: Record<string, never>): SyncResult;
  markFailed(p: { path: string; error: string }): void;
  status(p: Record<string, never>): WorkerStatus;
  listSessions(p: ListFilter): SessionListItem[];
  sessionMeta(p: { key: string }): SessionMeta | null;
  summary(p: Record<string, never>): IndexSummary;
  facets(p: Record<string, never>): { models: string[]; modes: string[]; sources: string[] };
  search(p: SearchRequest): SearchResponse;
  deleteIndex(p: Record<string, never>): void;
  /** Bench/tests only: pass-through heap numbers. */
  memory(p: Record<string, never>): { heapUsed: number; rss: number };
}

export type MethodName = keyof WorkerMethods;
export type ParamsOf<M extends MethodName> = Parameters<WorkerMethods[M]>[0];
export type ResultOf<M extends MethodName> = ReturnType<WorkerMethods[M]>;

export type HostToWorker = { type: 'req'; id: number; method: MethodName; params: unknown } | { type: 'cancel'; id: number };

export type WorkerEvent =
  | { event: 'progress'; done: number; total: number }
  | { event: 'parsing'; path: string }
  | { event: 'changed' }
  | { event: 'log'; level: 'info' | 'warn' | 'error'; message: string };

export type WorkerToHost =
  | { type: 'res'; id: number; ok: true; result: unknown }
  | { type: 'res'; id: number; ok: false; error: { name: string; message: string } }
  | ({ type: 'event' } & WorkerEvent);

export const WORKER_HEAP_MB = 256;
