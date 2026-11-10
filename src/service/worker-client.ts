import { Worker } from 'node:worker_threads';
import type { MethodName, ParamsOf, ResultOf, WorkerEvent, WorkerToHost } from '../worker/protocol';
import { WORKER_HEAP_MB } from '../worker/protocol';

/** Host side of the worker RPC: typed calls, cancellation, crash detection (R5.18). No vscode dependency. */

export interface CancellationLike {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}

export class RpcCancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelledError';
  }
}

export class WorkerCrashedError extends Error {
  constructor(
    readonly code: string,
    readonly lastParsing: string | undefined,
  ) {
    super(`index worker stopped (${code})`);
    this.name = 'WorkerCrashedError';
  }
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  dispose?: () => void;
}

export class WorkerClient {
  private worker: Worker;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private lastParsing: string | undefined;
  private disposed = false;

  constructor(
    private readonly scriptPath: string,
    private readonly onEvent: (e: WorkerEvent) => void,
    private readonly onCrash: (e: WorkerCrashedError) => void,
    private readonly heapMb = WORKER_HEAP_MB,
  ) {
    this.worker = this.spawn();
  }

  private spawn(): Worker {
    const w = new Worker(this.scriptPath, { resourceLimits: { maxOldGenerationSizeMb: this.heapMb } });
    w.on('message', (m: WorkerToHost) => this.onMessage(m));
    w.on('error', (e: Error & { code?: string }) => this.crashed(e.code ?? e.name));
    w.on('exit', (code) => {
      if (!this.disposed) this.crashed(`exit ${code}`);
    });
    w.unref();
    return w;
  }

  private crashed(code: string): void {
    if (this.disposed) return;
    const err = new WorkerCrashedError(code, this.lastParsing);
    for (const p of this.pending.values()) {
      p.dispose?.();
      p.reject(err);
    }
    this.pending.clear();
    this.disposed = true;
    void this.worker.terminate();
    this.onCrash(err);
  }

  /** Starts a fresh worker after a crash; callers must call `init` again. */
  restart(): void {
    this.disposed = false;
    this.lastParsing = undefined;
    this.worker = this.spawn();
  }

  private onMessage(m: WorkerToHost): void {
    if (m.type === 'event') {
      if (m.event === 'parsing') this.lastParsing = m.path;
      const { type: _type, ...event } = m;
      this.onEvent(event);
      return;
    }
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    p.dispose?.();
    if (m.ok) p.resolve(m.result);
    else {
      const err = m.error.name === 'CancelledError' ? new RpcCancelledError() : new Error(m.error.message);
      if (!(err instanceof RpcCancelledError)) err.name = m.error.name;
      p.reject(err);
    }
  }

  call<M extends MethodName>(method: M, params: ParamsOf<M>, token?: CancellationLike): Promise<Awaited<ResultOf<M>>> {
    if (this.disposed) return Promise.reject(new WorkerCrashedError('disposed', undefined));
    if (token?.isCancellationRequested) return Promise.reject(new RpcCancelledError());
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const entry: Pending = { resolve: resolve as (v: unknown) => void, reject };
      if (token) {
        const sub = token.onCancellationRequested(() => {
          if (!this.pending.has(id)) return;
          this.pending.delete(id);
          this.worker.postMessage({ type: 'cancel', id });
          reject(new RpcCancelledError());
        });
        entry.dispose = () => sub.dispose();
      }
      this.pending.set(id, entry);
      this.worker.postMessage({ type: 'req', id, method, params });
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const p of this.pending.values()) {
      p.dispose?.();
      p.reject(new RpcCancelledError());
    }
    this.pending.clear();
    await this.worker.terminate();
  }
}
