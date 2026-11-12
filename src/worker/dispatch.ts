import { CancelledError, type CancelToken } from './indexer';
import type { HostToWorker, MethodName, WorkerToHost } from './protocol';
import type { WorkerService } from './service';

type Handler = (service: WorkerService, params: never, token: CancelToken) => unknown;

/** Method table; the `satisfies` clause keeps it in sync with `WorkerMethods`. */
export const HANDLERS = {
  init: (s, p: Parameters<WorkerService['init']>[0]) => s.init(p),
  setRole: (s, p: { writer: boolean }) => s.setRole(p),
  updateSettings: (s, p: Parameters<WorkerService['updateSettings']>[0]) => s.updateSettings(p),
  sync: (s, p: { force?: boolean; throttle?: boolean }, t) => s.sync(p, t),
  rebuild: (s, _p: unknown, t) => s.rebuild(t),
  markFailed: (s, p: { path: string; error: string }) => s.markFailed(p),
  status: (s) => s.status(),
  listSessions: (s, p: Parameters<WorkerService['listSessions']>[0]) => s.listSessions(p),
  sessionMeta: (s, p: { key: string }) => s.sessionMeta(p),
  summary: (s) => s.summary(),
  facets: (s) => s.facets(),
  search: (s, p: Parameters<WorkerService['search']>[0], t) => s.search(p, t),
  statistics: (s, p: Parameters<WorkerService['statistics']>[0], t) => s.statistics(p, t),
  loadSession: (s, p: { key: string }) => s.loadSession(p),
  deleteIndex: (s) => s.deleteIndex(),
  memory: () => ({ heapUsed: process.memoryUsage().heapUsed, rss: process.memoryUsage().rss }),
} satisfies Record<MethodName, Handler>;

/**
 * Creates the message handler. Requests start on the next tick, so a `cancel` that arrives in the same message batch
 * (e.g. a newer Quick Pick query, R6.12) drops the stale request before it runs; long operations also poll the token.
 */
export function createDispatcher(service: WorkerService, post: (m: WorkerToHost) => void): (msg: HostToWorker) => void {
  const tokens = new Map<number, { cancelled: boolean }>();
  return (msg) => {
    if (msg.type === 'cancel') {
      const t = tokens.get(msg.id);
      if (t) t.cancelled = true;
      return;
    }
    const token = { cancelled: false };
    tokens.set(msg.id, token);
    setImmediate(() => {
      const fail = (e: unknown): void => {
        const err = e instanceof Error ? e : new Error(String(e));
        post({ type: 'res', id: msg.id, ok: false, error: { name: err.name, message: err.message } });
      };
      if (token.cancelled) {
        tokens.delete(msg.id);
        fail(new CancelledError());
        return;
      }
      const handler = HANDLERS[msg.method] as Handler | undefined;
      if (!handler) {
        tokens.delete(msg.id);
        fail(new Error(`unknown method ${String(msg.method)}`));
        return;
      }
      Promise.resolve()
        .then(() => handler(service, msg.params as never, token))
        .then(
          (result) => post({ type: 'res', id: msg.id, ok: true, result: result ?? null }),
          (e: unknown) => fail(e),
        )
        .finally(() => tokens.delete(msg.id));
    });
  };
}
