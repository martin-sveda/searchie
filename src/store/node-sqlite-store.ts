import fs from 'node:fs';
import { createRequire } from 'node:module';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { IndexStore, OpenOptions, RunResult, SqlParams } from './index-store';

/** `IndexStore` on the built-in `node:sqlite` (SPEC §5.1). File-backed; the live index uses WAL. */

type SqliteModule = typeof import('node:sqlite');
let sqliteModule: SqliteModule | undefined;

/** Loads node:sqlite lazily, suppressing only its one-time ExperimentalWarning (Node 22). */
export function loadSqlite(): SqliteModule {
  if (!sqliteModule) {
    const req = createRequire(__filename);
    const emit = process.emitWarning.bind(process);
    process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
      const text = typeof warning === 'string' ? warning : warning.message;
      if (/SQLite is an experimental feature/i.test(text)) return;
      (emit as (...a: unknown[]) => void)(warning, ...rest);
    });
    try {
      sqliteModule = req('node:sqlite') as SqliteModule;
    } finally {
      process.emitWarning = emit;
    }
  }
  return sqliteModule;
}

/** Creates the file with mode 0600 before SQLite opens it; SQLite gives -wal/-shm the same mode (R5.5). */
export function ensurePrivateFile(file: string): void {
  const fd = fs.openSync(file, 'a', 0o600);
  fs.closeSync(fd);
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}

class NodeSqliteStore implements IndexStore {
  private readonly statements = new Map<string, StatementSync>();
  private inTransaction = false;

  constructor(
    private readonly db: DatabaseSync,
    readonly path: string,
    readonly readOnly: boolean,
  ) {}

  private prepare(sql: string): StatementSync {
    let st = this.statements.get(sql);
    if (!st) {
      st = this.db.prepare(sql);
      this.statements.set(sql, st);
    }
    return st;
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  run(sql: string, params: SqlParams = []): RunResult {
    const r = this.prepare(sql).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  get<T>(sql: string, params: SqlParams = []): T | undefined {
    return this.prepare(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, params: SqlParams = []): T[] {
    return this.prepare(sql).all(...params) as T[];
  }

  transaction<T>(fn: () => T): T {
    if (this.inTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.inTransaction = true;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    } finally {
      this.inTransaction = false;
    }
  }

  dataVersion(): number {
    return (this.db.prepare('PRAGMA data_version').get() as { data_version: number }).data_version;
  }

  close(): void {
    this.statements.clear();
    if (this.db.isOpen) this.db.close();
  }
}

export function openNodeSqliteStore(path: string, options: OpenOptions = {}): IndexStore {
  const { DatabaseSync } = loadSqlite();
  const readOnly = options.readOnly === true;
  if (!readOnly) ensurePrivateFile(path);
  const db = new DatabaseSync(path, { readOnly });
  db.exec('PRAGMA busy_timeout = 5000');
  if (!readOnly) {
    db.exec(options.journal === 'delete' ? 'PRAGMA journal_mode = DELETE; PRAGMA synchronous = OFF' : 'PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL');
  }
  return new NodeSqliteStore(db, path, readOnly);
}

/**
 * R5.4 – publishes a finished cold-build file into the live index. If the live file exists, SQLite's online
 * backup copies it in one destination transaction, so open WAL readers switch atomically; otherwise it is renamed.
 */
export async function publishBuild(buildPath: string, livePath: string): Promise<void> {
  if (!fs.existsSync(livePath)) {
    for (const suffix of ['-wal', '-shm', '-journal']) fs.rmSync(livePath + suffix, { force: true });
    fs.renameSync(buildPath, livePath);
    openNodeSqliteStore(livePath).close();
    return;
  }
  const { DatabaseSync, backup } = loadSqlite();
  const src = new DatabaseSync(buildPath, { readOnly: true });
  try {
    await backup(src, livePath, { rate: 2048 });
  } finally {
    src.close();
  }
  fs.rmSync(buildPath, { force: true });
  fs.rmSync(`${buildPath}-journal`, { force: true });
  if (process.platform !== 'win32') {
    for (const f of [livePath, `${livePath}-wal`, `${livePath}-shm`]) if (fs.existsSync(f)) fs.chmodSync(f, 0o600);
  }
}
