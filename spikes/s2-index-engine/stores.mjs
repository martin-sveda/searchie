// Tiny IndexStore-shaped wrapper so engines are swappable (SPEC R5.2).
// Each store: exec(sql), run(sql, params), all(sql, params), begin(), commit(), persist(target), sizeBytes(), close().
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function atomicWrite(target, bytes) {
  const tmp = `${target}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, target);
}

/** node:sqlite – file-backed. Cold build writes to <target>.build then renames (atomic). */
export async function openNodeSqlite(target, { inMemory = false } = {}) {
  const { DatabaseSync } = require('node:sqlite');
  const buildPath = inMemory ? ':memory:' : `${target}.build`;
  if (!inMemory) for (const p of [buildPath, `${buildPath}-wal`, `${buildPath}-shm`]) fs.rmSync(p, { force: true });
  const db = new DatabaseSync(buildPath);
  if (!inMemory) { db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA page_size=4096'); fs.chmodSync(buildPath, 0o600); }
  const cache = new Map();
  const stmt = (sql) => { let s = cache.get(sql); if (!s) { s = db.prepare(sql); cache.set(sql, s); } return s; };
  return {
    name: 'node:sqlite',
    exec: (sql) => db.exec(sql),
    run: (sql, params = []) => stmt(sql).run(...params),
    all: (sql, params = []) => stmt(sql).all(...params),
    begin: () => db.exec('BEGIN'),
    commit: () => db.exec('COMMIT'),
    /** Cold build: checkpoint WAL, fsync, rename build file → target. Returns timings. */
    persist(dest = target) {
      const t0 = performance.now();
      if (inMemory) { const bytes = db.serialize(); const t1 = performance.now(); atomicWrite(dest, bytes); return { exportMs: t1 - t0, writeMs: performance.now() - t1, bytes: bytes.length }; }
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      const t1 = performance.now();
      const fd = fs.openSync(buildPath, 'r'); fs.fsyncSync(fd); fs.closeSync(fd);
      fs.copyFileSync(buildPath, `${dest}.tmp`); fs.renameSync(`${dest}.tmp`, dest);
      return { exportMs: t1 - t0, writeMs: performance.now() - t1, bytes: fs.statSync(dest).size };
    },
    /** Incremental commit cost is the COMMIT itself (WAL), measured by the caller. */
    sizeBytes: () => (inMemory ? db.serialize().length : (db.exec('PRAGMA wal_checkpoint(TRUNCATE)'), fs.statSync(buildPath).size)),
    close: () => db.close(),
  };
}

/** @sqlite.org/sqlite-wasm – in-memory DB, persisted by whole-DB export (same model as sql.js). */
export async function openSqliteWasm(target) {
  const { default: init } = await import('@sqlite.org/sqlite-wasm');
  const sqlite3 = await init();
  const db = new sqlite3.oo1.DB(':memory:');
  const cache = new Map();
  const stmt = (sql) => { let s = cache.get(sql); if (!s) { s = db.prepare(sql); cache.set(sql, s); } return s; };
  return {
    name: `sqlite-wasm ${sqlite3.version.libVersion}`,
    sqlite3,
    exec: (sql) => db.exec(sql),
    run: (sql, params = []) => { const s = stmt(sql); if (params.length) s.bind(params); s.stepReset(); s.clearBindings(); },
    all: (sql, params = []) => {
      const s = stmt(sql); const rows = [];
      try { if (params.length) s.bind(params); while (s.step()) rows.push(s.get({})); } finally { s.reset(); s.clearBindings(); }
      return rows;
    },
    begin: () => db.exec('BEGIN'),
    commit: () => db.exec('COMMIT'),
    persist(dest = target) {
      const t0 = performance.now();
      const bytes = sqlite3.capi.sqlite3_js_db_export(db.pointer);
      const t1 = performance.now();
      atomicWrite(dest, bytes);
      return { exportMs: t1 - t0, writeMs: performance.now() - t1, bytes: bytes.length };
    },
    sizeBytes: () => sqlite3.capi.sqlite3_js_db_export(db.pointer).length,
    wasmHeapBytes: () => sqlite3.wasm.heap8u().byteLength,
    close: () => { for (const s of cache.values()) s.finalize(); db.close(); },
  };
}

export const ENGINES = { 'node-sqlite': openNodeSqlite, 'sqlite-wasm': openSqliteWasm };
export { atomicWrite, path };
