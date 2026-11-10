// S2 benchmark driver – ONE engine/mode/variant per process so RSS baselines are not shared.
// Usage: ../node.sh bench.mjs <engine: node-sqlite|sqlite-wasm> <mode: real|synthetic> [variant: spec|noprefix]
// Env: DATA_ROOT (default /tmp/searchie-spike/data), WORKER_HEAP_MB (optional worker old-gen cap).
import { Worker } from 'node:worker_threads';
import fs from 'node:fs';

const [engine = 'node-sqlite', mode = 'real', variant = 'spec'] = process.argv.slice(2);
const dataRoot = process.env.DATA_ROOT || '/tmp/searchie-spike/data';
const heapCapMb = Number(process.env.WORKER_HEAP_MB || 0);
const outDir = '/tmp/searchie-spike/index';
fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });

const baseRss = process.memoryUsage.rss();
const w = new Worker(new URL('./bench-worker.mjs', import.meta.url), {
  workerData: { engine, mode, variant, dataRoot, outDir, targetTurns: 50_000 },
  ...(heapCapMb ? { resourceLimits: { maxOldGenerationSizeMb: heapCapMb } } : {}),
});
let peakRss = baseRss, peakHeap = 0, peakWasm = 0;
const timer = setInterval(async () => {
  peakRss = Math.max(peakRss, process.memoryUsage.rss());
  try { peakHeap = Math.max(peakHeap, (await w.getHeapStatistics()).used_heap_size); } catch { /* exited */ }
}, 25);
const result = await new Promise((resolve, reject) => {
  w.on('message', (m) => {
    peakRss = Math.max(peakRss, process.memoryUsage.rss());
    if (m.type === 'mark') { peakHeap = Math.max(peakHeap, m.heapUsed); if (m.wasmHeap) peakWasm = Math.max(peakWasm, m.wasmHeap); }
    if (m.type === 'done') resolve(m);
  });
  w.on('error', reject);
});
clearInterval(timer);
await w.terminate();
result.mem = { baseRss, peakRss, peakWorkerHeap: peakHeap, peakWasmHeap: peakWasm, heapCapMb };
result.runtime = { node: process.versions.node, electron: process.versions.electron ?? null, sqlite: process.versions.sqlite ?? null, platform: `${process.platform}/${process.arch}` };
fs.mkdirSync(new URL('./out/', import.meta.url), { recursive: true });
const file = new URL(`./out/result-${engine}-${mode}-${variant}${heapCapMb ? `-cap${heapCapMb}` : ''}.json`, import.meta.url);
fs.writeFileSync(file, JSON.stringify(result, null, 1));
process.stderr.write(`wrote ${file.pathname}\n`);
