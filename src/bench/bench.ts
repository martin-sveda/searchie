import fs from 'node:fs';
import path from 'node:path';
import { discoverWorkspaces, resolveRoots } from '../core/sources';
import { WorkerClient } from '../service/worker-client';
import type { IndexStore } from '../store/index-store';
import { openNodeSqliteStore } from '../store/node-sqlite-store';
import type { IndexerSettings } from '../worker/indexer';

/**
 * `npm run bench -- --data <VS Code User dir> [--synthetic 50000] [--out /tmp/searchie-dev/bench] [--reps 20]`
 * Prints N2, N3, N4, N6, N7 (SPEC §11). Output is counts and timings only – never text, terms or paths.
 * Writes only below --out (default /tmp/searchie-dev/bench); delete it afterwards.
 */

interface Args {
  data: string;
  out: string;
  synthetic: number;
  reps: number;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const data = get('data');
  if (!data) {
    console.error('usage: npm run bench -- --data <VS Code User dir> [--synthetic 50000] [--out dir] [--reps 20]');
    process.exit(2);
  }
  return { data: path.resolve(data), out: path.resolve(get('out') ?? '/tmp/searchie-dev/bench'), synthetic: Number(get('synthetic') ?? 0), reps: Number(get('reps') ?? 20) };
}

const settingsFor = (root: string): IndexerSettings => ({
  vscode: false,
  vscodeInsiders: false,
  emptyWindow: true,
  additionalSessionRoots: [root],
  excludeWorkspaces: [],
  includeThinking: false,
  maxTurnTextKB: 64,
  noisePatterns: [],
});

const mb = (b: number): string => (b / 1024 / 1024).toFixed(1);
const pct = (sorted: number[], p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;

async function sourceBytes(root: string): Promise<{ bytes: number; files: number }> {
  const ws = await discoverWorkspaces(resolveRoots(settingsFor(root)), { emptyWindow: true, excludeWorkspaces: [] });
  const files = ws.flatMap((w) => w.files);
  return { bytes: files.reduce((n, f) => n + f.size, 0), files: files.length };
}

function indexBytes(dir: string): number {
  return ['index.sqlite', 'index.sqlite-wal'].reduce((n, f) => n + (fs.existsSync(path.join(dir, f)) ? fs.statSync(path.join(dir, f)).size : 0), 0);
}

/** Queries derived from the index vocabulary by document-frequency percentile (terms are never printed). */
function buildQueries(store: IndexStore): [string, string][] {
  const vocab = store
    .all<{ term: string }>("SELECT term FROM turn_vocab WHERE length(term) BETWEEN 4 AND 20 AND term GLOB '[a-z]*' AND term NOT GLOB '*[0-9]*' ORDER BY doc DESC")
    .map((r) => r.term);
  if (vocab.length < 10) return [];
  const at = (p: number): string => vocab[Math.min(vocab.length - 1, Math.floor(vocab.length * p))]!;
  const model = store.get<{ m: string }>('SELECT model AS m FROM turns WHERE model IS NOT NULL GROUP BY model ORDER BY count(*) DESC LIMIT 1')?.m ?? 'x';
  const tool = store.get<{ t: string }>('SELECT tool AS t FROM turn_tools GROUP BY tool ORDER BY sum(count) DESC LIMIT 1')?.t ?? 'x';
  const ws = store.get<{ n: string }>('SELECT w.name AS n FROM sessions s JOIN workspaces w ON w.id = s.workspace_id GROUP BY w.name ORDER BY count(*) DESC LIMIT 1')?.n ?? 'x';
  const prompts = store.all<{ p: string }>('SELECT prompt AS p FROM turn_text WHERE length(prompt) > 40 LIMIT 200').map((r) => r.p);
  const phrase = (i: number): string => {
    const words = (prompts[i % Math.max(1, prompts.length)] ?? '').toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 3);
    return words.length >= 2 ? `"${words[0]} ${words[1]}"` : at(0.05);
  };
  return [
    ['single:high', at(0.001)],
    ['single:high', at(0.005)],
    ['single:mid', at(0.05)],
    ['single:mid', at(0.1)],
    ['single:low', at(0.4)],
    ['and', `${at(0.002)} ${at(0.02)}`],
    ['and', `${at(0.01)} ${at(0.03)}`],
    ['and', `${at(0.05)} ${at(0.08)}`],
    ['and3', `${at(0.003)} ${at(0.01)} ${at(0.06)}`],
    ['phrase', phrase(1)],
    ['phrase', phrase(7)],
    ['phrase', phrase(13)],
    ['prefix', `${at(0.01).slice(0, 3)}*`],
    ['prefix', `${at(0.05).slice(0, 4)}*`],
    ['prefix', `${at(0.2).slice(0, 5)}*`],
    ['or', `${at(0.02)} OR ${at(0.2)}`],
    ['or', `${at(0.05)} OR ${at(0.07)}`],
    ['or', `${at(0.001)} OR ${at(0.002)}`],
    ['not', `${at(0.004)} -${at(0.02)}`],
    ['column', `in:prompt ${at(0.01)}`],
    ['filter:model+date', `${at(0.01)} model:"${model}" after:30d`],
    ['filter:workspace', `${at(0.02)} ws:"${ws}"`],
    ['filter:tool', `${at(0.01)} tool:"${tool}"`],
    ['filter:mode+date', `${at(0.05)} mode:a after:90d`],
  ];
}

/** Writes synthetic sessions (shuffled real words, so the term distribution is kept) until `turns` is reached. */
function writeSynthetic(store: IndexStore, root: string, turns: number): void {
  const base = store.all<{ prompt: string; response: string; model: string | null }>(
    'SELECT x.prompt, x.response, t.model FROM turn_text x JOIN turns t ON t.id = x.id WHERE t.hidden = 0',
  );
  if (!base.length) throw new Error('no turns to scale up');
  let seed = 42;
  const rnd = (): number => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const shuffle = (s: string): string => {
    const w = s.split(/\s+/);
    for (let i = w.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [w[i], w[j]] = [w[j]!, w[i]!];
    }
    return w.join(' ');
  };
  const now = Date.now();
  let produced = 0;
  let sid = 0;
  while (produced < turns) {
    const n = Math.min(1 + Math.floor(rnd() * 12), turns - produced);
    const created = now - Math.floor(rnd() * 365 * 86_400_000);
    const ws = `synthetic${String(Math.floor(rnd() * 40)).padStart(2, '0')}`;
    const dir = path.join(root, 'workspaceStorage', ws, 'chatSessions');
    fs.mkdirSync(dir, { recursive: true });
    const wsJson = path.join(root, 'workspaceStorage', ws, 'workspace.json');
    if (!fs.existsSync(wsJson)) fs.writeFileSync(wsJson, JSON.stringify({ folder: `file:///synthetic/${ws}` }));
    const requests = Array.from({ length: n }, (_, i) => {
      const b = base[Math.floor(rnd() * base.length)]!;
      return { requestId: `r${i}`, timestamp: created + i * 60_000, modelId: b.model ?? 'model', modeInfo: { kind: 'agent' }, message: { text: shuffle(b.prompt) }, response: [{ value: shuffle(b.response) }] };
    });
    const id = `synthetic-${sid++}`;
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), `${JSON.stringify({ kind: 0, v: { sessionId: id, creationDate: created, requests } })}\n`);
    produced += n;
  }
}

async function run(label: string, root: string, outDir: string, reps: number, bytesPerTurn?: number): Promise<{ store: IndexStore; bytesPerTurn: number }> {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const src = await sourceBytes(root);
  const baseline = process.memoryUsage().rss;
  let peak = baseline;
  const sampler = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 25);
  const client = new WorkerClient(path.join(__dirname, 'worker.js'), () => undefined, (e) => console.error(`worker crashed: ${e.code}`));
  await client.call('init', { dir: outDir, settings: settingsFor(root), writer: true });
  const t0 = performance.now();
  const built = await client.call('sync', {});
  const buildMs = performance.now() - t0;
  const buildPeak = peak;

  // N3: mark the largest session file as changed and run an incremental sync.
  const store = openNodeSqliteStore(path.join(outDir, 'index.sqlite'));
  const target = store.get<{ path: string; ws: string; turns: number }>(
    "SELECT f.path, f.workspace_id AS ws, s.turn_count AS turns FROM files f JOIN sessions s ON s.file_path = f.path WHERE f.status = 'ok' ORDER BY f.size DESC LIMIT 1",
  );
  let incr = { ms: 0, turns: 0, parsed: 0 };
  if (target) {
    store.run('UPDATE files SET mtime = -1 WHERE path = ?', [target.path]);
    store.run('UPDATE workspaces SET fingerprint = NULL WHERE id = ?', [target.ws]);
    const t1 = performance.now();
    const r = await client.call('sync', {});
    incr = { ms: performance.now() - t1, turns: target.turns, parsed: r.stats?.parsed ?? 0 };
  }

  // N4: search latency over the worker RPC (includes message passing).
  const queries = buildQueries(store);
  const all: number[] = [];
  const byType = new Map<string, { times: number[]; matched: number; n: number }>();
  for (const [type, query] of queries) {
    const first = await client.call('search', { query });
    const entry = byType.get(type) ?? { times: [], matched: 0, n: 0 };
    entry.matched += first.total;
    entry.n++;
    for (let i = 0; i < reps; i++) {
      const t = performance.now();
      await client.call('search', { query });
      const ms = performance.now() - t;
      entry.times.push(ms);
      all.push(ms);
    }
    byType.set(type, entry);
  }
  clearInterval(sampler);
  await client.dispose();
  all.sort((a, b) => a - b);
  const counts = store.get<{ sessions: number; turns: number }>('SELECT (SELECT count(*) FROM sessions) AS sessions, (SELECT count(*) FROM turns) AS turns')!;
  const idx = indexBytes(outDir);
  // Synthetic files hold text only; compare against the real source size of the same number of turns (as in spike S2).
  const srcBytes = bytesPerTurn ? bytesPerTurn * counts.turns : src.bytes;
  const per500 = srcBytes > 0 ? buildMs / (srcBytes / (500 * 1024 * 1024)) / 1000 : 0;

  console.log(`\n## ${label}`);
  console.log(`source: ${src.files} files, ${mb(src.bytes)} MB${bytesPerTurn ? ` (equivalent real source: ${mb(srcBytes)} MB)` : ''} · indexed: ${counts.sessions} sessions, ${counts.turns} turns · failed files: ${built.stats?.failed ?? 0}`);
  console.log('| Target | Value | Limit | Pass |\n|---|---|---|---|');
  console.log(`| N2 cold build | ${(buildMs / 1000).toFixed(2)} s (${per500.toFixed(2)} s per 500 MB) | ≤ 90 s / 500 MB | ${per500 <= 90 ? '✅' : '❌'} |`);
  console.log(`| N3 incremental, 1 session (${incr.turns} turns, ${incr.parsed} parsed) | ${incr.ms.toFixed(0)} ms | < 1000 ms | ${incr.ms < 1000 ? '✅' : '❌'} |`);
  console.log(`| N4 search p95 (${queries.length} queries × ${reps}) | ${pct(all, 0.95).toFixed(1)} ms (p50 ${pct(all, 0.5).toFixed(1)}, max ${(all.at(-1) ?? 0).toFixed(1)}) | < 100 ms @ 50k turns | ${pct(all, 0.95) < 100 ? '✅' : '❌'} |`);
  console.log(`| N6 peak RSS during cold build | ${mb(buildPeak)} MB (baseline ${mb(baseline)} MB) | < 600 MB | ${buildPeak < 600 * 1024 * 1024 ? '✅' : '❌'} |`);
  console.log(`| N7 index size | ${mb(idx)} MB = ${srcBytes ? ((idx / srcBytes) * 100).toFixed(1) : '—'} % of source | ≤ 40 % | ${srcBytes && idx / srcBytes <= 0.4 ? '✅' : '❌'} |`);
  console.log('\n| Query type | n | matched sessions (avg) | p50 ms | p95 ms |\n|---|---|---|---|---|');
  for (const [type, e] of byType) {
    const t = [...e.times].sort((a, b) => a - b);
    console.log(`| ${type} | ${e.n} | ${Math.round(e.matched / e.n)} | ${pct(t, 0.5).toFixed(1)} | ${pct(t, 0.95).toFixed(1)} |`);
  }
  return { store, bytesPerTurn: counts.turns ? src.bytes / counts.turns : 0 };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const root = fs.existsSync(path.join(args.data, 'vscode')) ? path.join(args.data, 'vscode') : args.data;
  console.log(`# Searchie bench · Node ${process.versions.node} · SQLite ${process.versions.sqlite ?? '?'} · ${process.platform}/${process.arch}`);
  const { store, bytesPerTurn } = await run('Source data', root, path.join(args.out, 'real'), args.reps);
  if (args.synthetic > 0) {
    const synthRoot = path.join(args.out, 'synthetic-src');
    fs.rmSync(synthRoot, { recursive: true, force: true });
    writeSynthetic(store, synthRoot, args.synthetic);
    store.close();
    (await run(`Synthetic ${args.synthetic} turns`, synthRoot, path.join(args.out, 'synthetic'), args.reps, bytesPerTurn)).store.close();
  } else {
    store.close();
  }
  console.log(`\nIndex copies are in ${args.out} (mode 0600). Delete them when done: rm -rf ${args.out}`);
}

main().catch((e: unknown) => {
  console.error(`bench failed: ${(e as Error).name}`);
  process.exit(1);
});
