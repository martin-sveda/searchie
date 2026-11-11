import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RpcCancelledError, WorkerClient, WorkerCrashedError, type CancellationLike } from '../service/worker-client';
import { stableFixtureUserDir, MAIN_ID, tempDir } from '../test/helpers';
import type { IndexerSettings } from './indexer';
import type { WorkerEvent } from './protocol';

const settings: IndexerSettings = {
  vscode: false,
  vscodeInsiders: false,
  emptyWindow: true,
  additionalSessionRoots: [stableFixtureUserDir()],
  excludeWorkspaces: [],
  includeThinking: false,
  maxTurnTextKB: 64,
  noisePatterns: [],
};

function token(): CancellationLike & { cancel(): void } {
  const listeners: (() => void)[] = [];
  let cancelled = false;
  return {
    get isCancellationRequested() {
      return cancelled;
    },
    onCancellationRequested(l) {
      listeners.push(l);
      return { dispose: () => undefined };
    },
    cancel() {
      cancelled = true;
      for (const l of listeners) l();
    },
  };
}

describe('worker RPC (real worker_thread)', () => {
  let script: string;
  let client: WorkerClient;
  const events: WorkerEvent[] = [];
  const crashes: WorkerCrashedError[] = [];

  beforeAll(async () => {
    const out = tempDir('searchie-worker-');
    script = path.join(out, 'worker.js');
    await build({ entryPoints: [path.resolve(__dirname, 'worker.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node22', outfile: script, external: ['node:sqlite'], logLevel: 'silent' });
    client = new WorkerClient(script, (e) => events.push(e), (e) => crashes.push(e));
  });

  afterAll(async () => {
    await client.dispose();
  });

  it('initialises, cold-builds and answers queries', async () => {
    const dir = tempDir();
    expect(await client.call('init', { dir, settings, writer: true })).toMatchObject({ role: 'writer', hasIndex: false });
    const r = await client.call('sync', {});
    expect(r.rebuilt).toBe('missing');
    expect(r.stats?.sessionsWritten).toBeGreaterThanOrEqual(3);
    expect(events.some((e) => e.event === 'changed')).toBe(true);
    expect(events.some((e) => e.event === 'parsing')).toBe(true);
    const list = await client.call('listSessions', {});
    expect(list).toHaveLength(3);
    expect((await client.call('sessionMeta', { key: `vscode:${MAIN_ID}` }))?.title).toBe('Sample parser refactoring');
    expect((await client.call('summary', {})).sessions).toBe(3);
    expect((await client.call('facets', {})).modes).toEqual(['Agent']);
    const loaded = await client.call('loadSession', { key: `vscode:${MAIN_ID}` });
    expect(loaded?.turns).toHaveLength(3);
    expect(loaded?.turns[0]!.parts?.map((x) => x.kind)).toEqual(['thinking', 'tool', 'tool', 'markdown']);
    expect(await client.call('loadSession', { key: 'vscode:missing' })).toBeNull();
    const found = await client.call('search', { query: 'clenu' });
    expect(found.results.map((r) => r.session.id)).toEqual([MAIN_ID]);
    const again = await client.call('sync', { throttle: true });
    expect(again).toMatchObject({ rebuilt: null, stats: { parsed: 0 } });
    expect((await client.call('memory', {})).heapUsed).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(dir, 'index.sqlite'))).toBe(true);
  });

  it('opens a second worker as a read-only reader of the same index', async () => {
    const dir = tempDir();
    await client.call('init', { dir, settings, writer: true });
    await client.call('sync', {});
    const reader = new WorkerClient(script, () => undefined, () => undefined);
    try {
      expect(await reader.call('init', { dir, settings, writer: false })).toMatchObject({ role: 'reader', hasIndex: true });
      expect(await reader.call('listSessions', {})).toHaveLength(3);
      expect(await reader.call('sync', {})).toMatchObject({ role: 'reader', stats: null });
      await reader.call('markFailed', { path: '/nope', error: 'x' });
    } finally {
      await reader.dispose();
    }
  });

  it('rebuilds on request and deletes the index', async () => {
    const dir = tempDir();
    await client.call('init', { dir, settings, writer: true });
    await client.call('sync', {});
    expect((await client.call('rebuild', {})).rebuilt).toBe('requested');
    await client.call('deleteIndex', {});
    expect(fs.existsSync(path.join(dir, 'index.sqlite'))).toBe(false);
    expect(await client.call('listSessions', {})).toEqual([]);
    expect((await client.call('search', { query: 'x' })).results).toEqual([]);
    expect(await client.call('status', {})).toMatchObject({ hasIndex: false });
  });

  it('cancels a request before it runs', async () => {
    const t = token();
    const p = client.call('summary', {}, t);
    t.cancel();
    await expect(p).rejects.toBeInstanceOf(RpcCancelledError);
    const already = token();
    already.cancel();
    await expect(client.call('summary', {}, already)).rejects.toBeInstanceOf(RpcCancelledError);
    expect((await client.call('summary', {})).failedFiles).toBe(0);
  });

  it('reports unknown methods and errors', async () => {
    await expect(client.call('nope' as never, {} as never)).rejects.toThrow('unknown method');
  });

  it('detects a worker that runs out of memory (R5.18)', async () => {
    const dir = tempDir('searchie-oom-');
    const oom = path.join(dir, 'oom.js');
    fs.writeFileSync(oom, "const a=[];require('node:worker_threads').parentPort.on('message',()=>{for(;;)a.push(new Array(1e5).fill(Math.random()))});");
    const crashed: WorkerCrashedError[] = [];
    const c = new WorkerClient(oom, () => undefined, (e) => crashed.push(e), 16);
    await expect(c.call('summary', {})).rejects.toBeInstanceOf(WorkerCrashedError);
    expect(crashed[0]?.code).toBe('ERR_WORKER_OUT_OF_MEMORY');
    await expect(c.call('summary', {})).rejects.toBeInstanceOf(WorkerCrashedError);
    await c.dispose();
  });
});
