import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

/**
 * Single-writer lock (R5.3): `index.lock` holds `{ pid, token, heartbeat }`. A lock is stale when its heartbeat is
 * older than 30 s or its process is gone. Held by the extension host (not the worker), so a worker restart keeps it.
 */

export interface LockContent {
  pid: number;
  token: string;
  heartbeat: number;
}

export interface LockOptions {
  staleMs?: number;
  now?: () => number;
  isAlive?: (pid: number) => boolean;
}

export const LOCK_STALE_MS = 30_000;
export const LOCK_HEARTBEAT_MS = 10_000;

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class IndexLock {
  readonly token = randomUUID();
  private held = false;
  private readonly staleMs: number;
  private readonly now: () => number;
  private readonly isAlive: (pid: number) => boolean;

  constructor(
    readonly file: string,
    options: LockOptions = {},
  ) {
    this.staleMs = options.staleMs ?? LOCK_STALE_MS;
    this.now = options.now ?? Date.now;
    this.isAlive = options.isAlive ?? pidAlive;
  }

  get isHeld(): boolean {
    return this.held;
  }

  read(): LockContent | undefined {
    try {
      const v: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        if (typeof o.pid === 'number' && typeof o.token === 'string' && typeof o.heartbeat === 'number') return { pid: o.pid, token: o.token, heartbeat: o.heartbeat };
      }
    } catch {
      // missing or half-written
    }
    return undefined;
  }

  isStale(c: LockContent | undefined): boolean {
    if (!c) return true;
    return this.now() - c.heartbeat > this.staleMs || !this.isAlive(c.pid);
  }

  private content(): string {
    return JSON.stringify({ pid: process.pid, token: this.token, heartbeat: this.now() } satisfies LockContent);
  }

  private create(): boolean {
    try {
      fs.writeFileSync(this.file, this.content(), { flag: 'wx', mode: 0o600 });
      this.held = true;
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw e;
    }
  }

  /** Tries to become the writer; takes over a stale lock. */
  tryAcquire(): boolean {
    if (this.held) return this.heartbeat();
    if (this.create()) return true;
    const current = this.read();
    if (current?.token === this.token) {
      this.held = true;
      return this.heartbeat();
    }
    if (!this.isStale(current)) return false;
    try {
      fs.unlinkSync(this.file);
    } catch {
      // someone else removed it first
    }
    return this.create();
  }

  /** Refreshes the heartbeat; returns false (and drops the role) when another window took the lock. */
  heartbeat(): boolean {
    if (!this.held) return false;
    if (this.read()?.token !== this.token) {
      this.held = false;
      return false;
    }
    fs.writeFileSync(this.file, this.content(), { mode: 0o600 });
    return true;
  }

  release(): void {
    if (!this.held) return;
    this.held = false;
    if (this.read()?.token === this.token) fs.rmSync(this.file, { force: true });
  }
}
