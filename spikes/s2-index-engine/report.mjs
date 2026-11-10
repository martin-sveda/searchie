// Prints the N-target tables from out/result-*.json. Usage: ../node.sh report.mjs
import fs from 'node:fs';

const MB = 1024 * 1024;
const dir = new URL('./out/', import.meta.url);
const files = fs.readdirSync(dir).filter((f) => /^result-.*\.json$/.test(f)).sort();
const pctl = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(s.length * p) - 1)]; };
const f = (x, d = 0) => (x === undefined || x === null || Number.isNaN(x) ? '—' : Number(x).toFixed(d));
const pass = (ok) => (ok ? '✅' : '❌');

for (const file of files) {
  const r = JSON.parse(fs.readFileSync(new URL(file, dir), 'utf8'));
  const all = r.searchResults.flatMap((s) => s.times ?? []);
  const p95 = pctl(all, 0.95), p50 = pctl(all, 0.5);
  const srcMB = r.sourceBytes / MB;
  const per500 = (r.timings.buildMs / 1000) * (500 / srcMB);
  const insertPer50k = (r.timings.insertMs / 1000) * (50000 / r.counts.turns);
  const peakRssMB = r.mem.peakRss / MB;
  const synth = r.mode === 'synthetic';
  console.log(`### ${r.engine} · ${r.mode} · schema ${r.variant}${r.mem.heapCapMb ? ` · worker heap cap ${r.mem.heapCapMb} MB` : ''}`);
  console.log(`${r.counts.sessions} sessions, ${r.counts.turns} turns, source ${f(srcMB)} MB${synth ? ' (equivalent, scaled from real bytes/turn)' : ''}, indexed text ${f(r.counts.textBytes / MB, 1)} MB · Node ${r.runtime.node}, Electron ${r.runtime.electron}\n`);
  console.log('| Metric | Target | Actual | Pass |\n|---|---|---|---|');
  console.log(`| N2 cold build per 500 MB source | ≤ 90 s | ${f(per500, 1)} s (build ${f(r.timings.buildMs / 1000, 1)} s = parse ${f(r.timings.parseMs / 1000, 1)} s + insert ${f(r.timings.insertMs / 1000, 1)} s; insert ≙ ${f(insertPer50k, 1)} s / 50k turns) | ${pass(per500 <= 90)} |`);
  console.log(`| N6 peak RSS, whole process (baseline ${f(r.mem.baseRss / MB)} MB) | < 600 MB | ${f(peakRssMB)} MB (worker JS heap ${f(r.mem.peakWorkerHeap / MB)} MB${r.mem.peakWasmHeap ? `, WASM heap ${f(r.mem.peakWasmHeap / MB)} MB` : ''}) | ${pass(peakRssMB < 600)} |`);
  console.log(`| Persist: export / atomic write | — | ${f(r.timings.exportMs)} ms / ${f(r.timings.atomicWriteMs)} ms | — |`);
  console.log(`| N7 index size vs source | ≤ 40 % | ${f(r.indexBytes / MB, 1)} MB = ${f((100 * r.indexBytes) / r.sourceBytes, 1)} % (${f(r.indexBytes / r.counts.textBytes, 2)}× indexed text) | ${pass(r.indexBytes / r.sourceBytes <= 0.4)} |`);
  console.log(`| N3 incremental update, 1 session (${r.incr.turns} turns) | < 1 s | ${f(r.incr.totalMs)} ms (tx ${f(r.incr.txMs)} + persist ${f(r.incr.persistMs)}) | ${pass(r.incr.totalMs < 1000)} |`);
  console.log(`| N4 search p95, top 50, ${r.queryCount} queries × 20 | < 100 ms @ 50k | p95 ${f(p95, 1)} ms (p50 ${f(p50, 1)}, max ${f(Math.max(...all), 1)}) | ${r.counts.turns >= 50000 ? pass(p95 < 100) : 'n/a (< 50k turns)'} |`);
  console.log(`| Reopen persisted index | — | ${f(r.timings.reopenMs)} ms | — |\n`);
  const byType = {};
  for (const s of r.searchResults) { const v = (byType[s.type] ||= { times: [], hits: [] }); if (s.times) { v.times.push(...s.times); v.hits.push(s.matchedTurns); } else v.error = s.error; }
  console.log('| Query type | queries | matched turns (avg) | p50 ms | p95 ms |\n|---|---|---|---|---|');
  for (const [t, v] of Object.entries(byType)) console.log(`| ${t} | ${v.hits.length} | ${v.error ? `ERROR ${v.error}` : f(v.hits.reduce((a, b) => a + b, 0) / v.hits.length)} | ${f(pctl(v.times, 0.5), 1)} | ${f(pctl(v.times, 0.95), 1)} |`);
  if (r.sizeBreakdown && !r.sizeBreakdown.error) {
    console.log('\n| Table / index | MB | % |\n|---|---|---|');
    const tot = Object.values(r.sizeBreakdown).reduce((a, b) => a + b, 0);
    for (const [k, v] of Object.entries(r.sizeBreakdown).slice(0, 8)) console.log(`| ${k} | ${f(v / MB, 1)} | ${f((100 * v) / tot, 1)} |`);
  }
  console.log(`\nparse stats: ${JSON.stringify(r.parseStats)}\n`);
}
