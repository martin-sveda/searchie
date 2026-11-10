// Runs inside a worker_thread: cold build → persist → reopen → incremental update → search benchmark.
import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import v8 from 'node:v8';
import { SCHEMA_SQL } from './schema.mjs';
import { ENGINES } from './stores.mjs';
import { discoverVsCode, discoverCli } from './discover.mjs';
import { parseVsCodeFile, parseCliFile, turnText, isNoise } from './map.mjs';

const { engine, mode, dataRoot, outDir, targetTurns, batchSize = 250, reps = 20, variant = 'spec' } = workerData;
const target = path.join(outDir, `index-${engine}-${mode}-${variant}.sqlite`);
const mark = (label, extra = {}) => parentPort.postMessage({ type: 'mark', label, heapUsed: v8.getHeapStatistics().used_heap_size, ...extra });

let seed = 42;
const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const shuffleWords = (s) => { const w = s.split(/\s+/); for (let i = w.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [w[i], w[j]] = [w[j], w[i]]; } return w.join(' '); };

const store = await ENGINES[engine](target);
store.exec(variant === 'noprefix' ? SCHEMA_SQL.replace(",\n  prefix='2 3'", '') : SCHEMA_SQL);
store.run('INSERT INTO meta(key,value) VALUES (?,?)', ['schemaVersion', '1']);

const SQL = {
  ws: 'INSERT OR IGNORE INTO workspaces(id,source,name,uri) VALUES (?,?,?,?)',
  file: 'INSERT OR REPLACE INTO files(path,source,workspace_id,mtime,size,parser_version,status,error) VALUES (?,?,?,?,?,?,?,?)',
  session: `INSERT OR REPLACE INTO sessions(id,file_path,source,workspace_id,title,created_at,last_at,turn_count,prompt_count,noise_count,
    canceled_count,tool_call_count,prompt_tokens,completion_tokens,credits,elapsed_ms,size_bytes,primary_model,primary_mode) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  turn: `INSERT INTO turns(id,session_id,idx,ts,model,mode,prompt_tokens,completion_tokens,credits,elapsed_ms,hidden,canceled,noise) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  tool: 'INSERT INTO turn_tools(turn_id,tool,count) VALUES (?,?,?)',
  text: 'INSERT INTO turn_text(id,title,prompt,response,tools,files,aux) VALUES (?,?,?,?,?,?,?)',
  fts: 'INSERT INTO turn_fts(rowid,title,prompt,response,tools,files,aux) VALUES (?,?,?,?,?,?,?)',
};
let nextTurnId = 1;
const counts = { sessions: 0, turns: 0, toolCalls: 0, textBytes: 0 };
const top = (o) => Object.entries(o).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function insertSession(f, s) {
  store.run(SQL.ws, [f.workspaceId, f.source, f.workspaceUri ?? f.workspaceId, f.workspaceUri]);
  store.run(SQL.file, [f.path, f.source, f.workspaceId, f.mtime ?? 0, f.size, 1, 'ok', null]);
  const agg = { prompts: 0, noise: 0, canceled: 0, tools: 0, pt: 0, ct: 0, cr: 0, el: 0, models: {}, modes: {}, last: s.createdAt };
  for (const t of s.turns) {
    const id = nextTurnId++;
    const noise = isNoise(t.prompt);
    const tx = turnText(s.title, t);
    store.run(SQL.turn, [id, s.id, t.idx, t.ts, t.model ?? null, t.mode ?? null, n(t.promptTokens), n(t.completionTokens), n(t.credits), n(t.elapsedMs), t.hidden ? 1 : 0, t.canceled ? 1 : 0, noise ? 1 : 0]);
    const toolCounts = {};
    for (const c of t.tools) toolCounts[c.tool] = (toolCounts[c.tool] || 0) + 1;
    for (const [tool, c] of Object.entries(toolCounts)) store.run(SQL.tool, [id, tool, c]);
    const cols = [id, tx.title, tx.prompt, tx.response, tx.tools, tx.files, tx.aux];
    store.run(SQL.text, cols);
    store.run(SQL.fts, cols);
    counts.turns++; counts.toolCalls += t.tools.length;
    counts.textBytes += tx.title.length + tx.prompt.length + tx.response.length + tx.tools.length + tx.files.length + tx.aux.length;
    if (!t.hidden && t.prompt.trim()) agg.prompts++;
    if (noise) agg.noise++;
    if (t.canceled) agg.canceled++;
    agg.tools += t.tools.length; agg.pt += t.promptTokens ?? 0; agg.ct += t.completionTokens ?? 0; agg.cr += t.credits ?? 0; agg.el += t.elapsedMs ?? 0;
    if (t.model) agg.models[t.model] = (agg.models[t.model] || 0) + 1;
    if (t.mode) agg.modes[t.mode] = (agg.modes[t.mode] || 0) + 1;
    agg.last = Math.max(agg.last, t.ts);
  }
  store.run(SQL.session, [s.id, f.path, f.source, f.workspaceId, s.title, s.createdAt, agg.last, s.turns.length, agg.prompts, agg.noise, agg.canceled,
    agg.tools, agg.pt, agg.ct, agg.cr, agg.el, f.size, top(agg.models), top(agg.modes)]);
  counts.sessions++;
}

function deleteSession(sessionId) {
  const rows = store.all('SELECT t.id, x.title, x.prompt, x.response, x.tools, x.files, x.aux FROM turns t JOIN turn_text x ON x.id = t.id WHERE t.session_id = ?', [sessionId]);
  for (const r of rows) store.run(`INSERT INTO turn_fts(turn_fts,rowid,title,prompt,response,tools,files,aux) VALUES ('delete',?,?,?,?,?,?,?)`, [r.id, r.title, r.prompt, r.response, r.tools, r.files, r.aux]);
  store.run('DELETE FROM turn_text WHERE id IN (SELECT id FROM turns WHERE session_id = ?)', [sessionId]);
  store.run('DELETE FROM turn_tools WHERE turn_id IN (SELECT id FROM turns WHERE session_id = ?)', [sessionId]);
  store.run('DELETE FROM turns WHERE session_id = ?', [sessionId]);
  store.run('DELETE FROM sessions WHERE id = ?', [sessionId]);
}

// ---------- cold build ----------
const timings = {};
const parseStats = {};
let sourceBytes = 0;
const tBuild = performance.now();
let parseMs = 0, insertMs = 0;
let batch = [];
const flush = () => {
  if (!batch.length) return;
  const t0 = performance.now();
  store.begin();
  for (const [f, s] of batch) insertSession(f, s);
  store.commit();
  insertMs += performance.now() - t0;
  batch = [];
  mark('batch', { sessions: counts.sessions, turns: counts.turns, wasmHeap: store.wasmHeapBytes?.() });
};

const realFiles = [...discoverVsCode(path.join(dataRoot, 'vscode')), ...discoverCli(path.join(dataRoot, 'cli'))];
const basePool = [];
const seenIds = new Set();
for (const f of realFiles) {
  sourceBytes += f.size;
  const t0 = performance.now();
  let s = null;
  try { s = f.source === 'copilot-cli' ? await parseCliFile(f, parseStats) : await parseVsCodeFile(f, parseStats); } catch { parseStats.failed = (parseStats.failed || 0) + 1; }
  parseMs += performance.now() - t0;
  if (!s || !s.turns.length) { parseStats.empty = (parseStats.empty || 0) + 1; continue; }
  // Same sessionId can exist in several workspaceStorage folders (storage copied on folder → .code-workspace).
  if (seenIds.has(s.id)) { parseStats.duplicateSessionIds = (parseStats.duplicateSessionIds || 0) + 1; continue; }
  seenIds.add(s.id);
  if (mode === 'synthetic') basePool.push({ f, s }); else batch.push([f, s]);
  if (batch.length >= batchSize) flush();
}
flush();

let syntheticSourceBytes = 0;
if (mode === 'synthetic') {
  // Scale-up: duplicate real turns with shuffled word order into synthetic sessions until targetTurns.
  const now = Date.now();
  const realTurns = basePool.reduce((a, b) => a + b.s.turns.length, 0);
  const bytesPerTurn = sourceBytes / realTurns;
  const wsIds = Array.from({ length: 40 }, (_, i) => `synthetic-ws-${i}`);
  let produced = 0; let sid = 0;
  while (produced < targetTurns) {
    const base = pick(basePool);
    const turnsN = Math.min(base.s.turns.length, targetTurns - produced);
    const created = now - Math.floor(rnd() * 365 * 864e5);
    const turns = base.s.turns.slice(0, turnsN).map((t, i) => ({ ...t, idx: i, ts: created + i * 60_000, prompt: shuffleWords(t.prompt), response: shuffleWords(t.response) }));
    const ws = pick(wsIds);
    const f = { path: `synthetic/${sid}.jsonl`, source: 'vscode', workspaceId: ws, workspaceUri: `file:///synthetic/${ws}`, size: Math.round(bytesPerTurn * turnsN) };
    syntheticSourceBytes += f.size;
    batch.push([f, { id: `synthetic-${sid++}`, title: shuffleWords(base.s.title), createdAt: created, turns }]);
    produced += turnsN;
    if (batch.length >= batchSize) flush();
  }
  flush();
}
timings.parseMs = parseMs;
timings.insertMs = insertMs;
timings.buildMs = performance.now() - tBuild;

// ---------- persist (cold) ----------
const tOpt = performance.now();
store.exec("INSERT INTO turn_fts(turn_fts) VALUES ('optimize')");
timings.ftsOptimizeMs = performance.now() - tOpt;
const persist = store.persist();
timings.exportMs = persist.exportMs;
timings.atomicWriteMs = persist.writeMs;
const indexBytes = persist.bytes;
mark('persisted');
let sizeBreakdown = null;
try {
  sizeBreakdown = Object.fromEntries(store.all("SELECT name, sum(pgsize) bytes FROM dbstat GROUP BY name ORDER BY bytes DESC").map((r) => [r.name, r.bytes]));
} catch (e) { sizeBreakdown = { error: e.message }; }

const buildCounts = { ...counts };
// ---------- incremental update of one session (N3) ----------
const someSession = store.all('SELECT id, file_path FROM sessions ORDER BY turn_count DESC LIMIT 1')[0];
const incr = {};
{
  const turns = store.all('SELECT t.idx, t.ts, t.model, t.mode, x.prompt, x.response FROM turns t JOIN turn_text x ON x.id = t.id WHERE t.session_id = ? ORDER BY t.idx', [someSession.id]);
  const s = { id: someSession.id, title: 'updated', createdAt: turns[0]?.ts ?? 0, turns: turns.map((t) => ({ ...t, tools: [], files: [], hidden: false, canceled: false })) };
  const t0 = performance.now();
  store.begin(); deleteSession(someSession.id); insertSession({ path: someSession.file_path, source: 'vscode', workspaceId: 'incr', workspaceUri: null, size: 0 }, s); store.commit();
  incr.txMs = performance.now() - t0;
  incr.turns = turns.length;
  if (engine === 'sqlite-wasm') { const p = store.persist(); incr.persistMs = p.exportMs + p.writeMs; } else incr.persistMs = 0; // node:sqlite: COMMIT is durable (WAL)
  incr.totalMs = incr.txMs + incr.persistMs;
}

// ---------- search benchmark (N4) ----------
const vocab = store.all("SELECT term, doc FROM turn_vocab WHERE length(term) BETWEEN 4 AND 20 AND term GLOB '[a-z]*' AND term NOT GLOB '*[0-9]*' ORDER BY doc DESC");
const pct = (p) => vocab[Math.min(vocab.length - 1, Math.floor(vocab.length * p))].term;
const q = (t) => `"${t.replace(/"/g, '""')}"`;
const promptSample = store.all("SELECT prompt FROM turn_text WHERE length(prompt) > 40 LIMIT 500").map((r) => r.prompt);
const phrase = () => { for (;;) { const w = pick(promptSample).toLowerCase().split(/[^a-z]+/).filter((x) => x.length >= 3); if (w.length >= 2) { const i = Math.floor(rnd() * (w.length - 1)); return `"${w[i]} ${w[i + 1]}"`; } } };
const topModel = store.all('SELECT model FROM turns WHERE model IS NOT NULL GROUP BY model ORDER BY count(*) DESC LIMIT 1')[0]?.model ?? '';
const topTool = store.all('SELECT tool FROM turn_tools GROUP BY tool ORDER BY sum(count) DESC LIMIT 1')[0]?.tool ?? '';
const topWs = store.all('SELECT workspace_id w FROM sessions GROUP BY workspace_id ORDER BY count(*) DESC LIMIT 1')[0]?.w ?? '';
const maxTs = store.all('SELECT max(ts) m FROM turns')[0].m;
const after30d = maxTs - 30 * 864e5;
const queries = [
  ['single:high', q(pct(0.001))], ['single:high', q(pct(0.005))], ['single:mid', q(pct(0.05))], ['single:mid', q(pct(0.1))], ['single:low', q(pct(0.4))],
  ['and', `${q(pct(0.002))} ${q(pct(0.02))}`], ['and', `${q(pct(0.01))} ${q(pct(0.03))}`], ['and', `${q(pct(0.05))} ${q(pct(0.08))}`], ['and3', `${q(pct(0.003))} ${q(pct(0.01))} ${q(pct(0.06))}`],
  ['phrase', phrase()], ['phrase', phrase()], ['phrase', phrase()],
  ['prefix', `${q(pct(0.01).slice(0, 3))}*`], ['prefix', `${q(pct(0.05).slice(0, 4))}*`], ['prefix', `${q(pct(0.2).slice(0, 5))}*`],
  ['or', `${q(pct(0.02))} OR ${q(pct(0.2))}`], ['or', `${q(pct(0.05))} OR ${q(pct(0.07))}`], ['or', `${q(pct(0.001))} OR ${q(pct(0.002))}`],
  ['not', `${q(pct(0.004))} NOT ${q(pct(0.02))}`],
  ['column', `{prompt} : ${q(pct(0.01))}`],
  ['filter:model+date', q(pct(0.01)), 'AND t.model = ? AND t.ts >= ?', [topModel, after30d]],
  ['filter:workspace', q(pct(0.02)), 'AND t.session_id IN (SELECT id FROM sessions WHERE workspace_id = ?)', [topWs]],
  ['filter:tool', q(pct(0.01)), 'AND EXISTS (SELECT 1 FROM turn_tools tt WHERE tt.turn_id = t.id AND tt.tool = ?)', [topTool]],
  ['filter:mode+date', q(pct(0.05)), 'AND t.mode IS NOT NULL AND t.ts >= ?', [after30d]],
];

const W = 'bm25(turn_fts,5,4,1,1.5,2,0.5)';
const SCORE = `(-${W} * (1 + 0.2 * exp(-(? - t.ts) / 7776000000.0)) * (CASE t.noise WHEN 1 THEN 0.2 ELSE 1 END))`;
function search(match, filter = '', fparams = []) {
  const now = maxTs;
  const agg = store.all(`WITH m AS MATERIALIZED (SELECT t.session_id sid, ${SCORE} s FROM turn_fts JOIN turns t ON t.id = turn_fts.rowid
    WHERE turn_fts MATCH ? AND t.hidden = 0 ${filter}) SELECT sid, max(s) best, count(*) k FROM m GROUP BY sid`, [now, match, ...fparams]);
  agg.forEach((r) => { r.score = r.best + 0.25 * Math.log(r.k); });
  agg.sort((a, b) => b.score - a.score);
  const top50 = agg.slice(0, 50);
  if (!top50.length) return { sessions: 0, matchedSessions: 0, matchedTurns: 0 };
  const rows = store.all(`SELECT turn_fts.rowid id, t.session_id sid, ${SCORE} s,
      snippet(turn_fts, 1, char(1), char(2), '…', 24) sp, snippet(turn_fts, 2, char(1), char(2), '…', 24) sr
    FROM turn_fts JOIN turns t ON t.id = turn_fts.rowid
    WHERE turn_fts MATCH ? AND t.hidden = 0 AND t.session_id IN (SELECT value FROM json_each(?)) ${filter}`, [now, match, JSON.stringify(top50.map((r) => r.sid)), ...fparams]);
  const bySession = new Map();
  for (const r of rows) { const a = bySession.get(r.sid) ?? []; a.push(r); bySession.set(r.sid, a); }
  const results = top50.map((s) => ({ sid: s.sid, score: s.score, turns: (bySession.get(s.sid) ?? []).sort((a, b) => b.s - a.s).slice(0, 3).map((r) => (r.sp.includes('\u0001') ? r.sp : r.sr)) }));
  return { sessions: results.length, matchedSessions: agg.length, matchedTurns: agg.reduce((a, b) => a + b.k, 0) };
}

const searchResults = [];
for (const [type, match, filter, fparams] of queries) {
  let info;
  try { info = search(match, filter, fparams); } catch (e) { searchResults.push({ type, error: e.message }); continue; }
  const times = [];
  for (let i = 0; i < reps; i++) { const t0 = performance.now(); search(match, filter, fparams); times.push(performance.now() - t0); }
  searchResults.push({ type, ...info, times });
}
mark('searched');

// ---------- reopen persisted index (startup cost, R5.13) ----------
store.close();
const tOpen = performance.now();
let reopenRows;
if (engine === 'node-sqlite') {
  const { DatabaseSync } = (await import('node:module')).createRequire(import.meta.url)('node:sqlite');
  const db = new DatabaseSync(target, { readOnly: true });
  reopenRows = db.prepare('SELECT count(*) n FROM turns').get().n; db.close();
} else {
  const { default: init } = await import('@sqlite.org/sqlite-wasm');
  const sqlite3 = await init();
  const buf = fs.readFileSync(target); const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
  const db = new sqlite3.oo1.DB(':memory:');
  const p = sqlite3.wasm.allocFromTypedArray(bytes);
  const rc = sqlite3.capi.sqlite3_deserialize(db.pointer, 'main', p, bytes.length, bytes.length, sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE);
  if (rc) throw new Error(`deserialize rc=${rc}`);
  reopenRows = db.selectValue('SELECT count(*) FROM turns'); db.close();
}
timings.reopenMs = performance.now() - tOpen;

parentPort.postMessage({
  type: 'done', engine: store.name, mode, counts: buildCounts, parseStats, sourceBytes: mode === 'synthetic' ? syntheticSourceBytes : sourceBytes,
  realSourceBytes: sourceBytes, indexBytes, sizeBreakdown, variant, timings, incr, reopenRows, searchResults, queryCount: queries.length,
});
