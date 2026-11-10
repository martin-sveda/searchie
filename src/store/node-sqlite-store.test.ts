import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../test/helpers';
import { IndexLock } from './lock';
import { ensurePrivateFile, loadSqlite, openNodeSqliteStore, publishBuild } from './node-sqlite-store';

const posix = process.platform !== 'win32';

describe('openNodeSqliteStore', () => {
  it('opens a private WAL database and supports run/get/all', () => {
    const file = path.join(tempDir(), 'index.sqlite');
    const s = openNodeSqliteStore(file);
    s.exec('CREATE TABLE t(a, b)');
    expect(s.run('INSERT INTO t VALUES (?, ?)', [1, 'x'])).toEqual({ changes: 1, lastInsertRowid: 1 });
    expect(s.get<{ a: number }>('SELECT a FROM t WHERE b = ?', ['x'])?.a).toBe(1);
    expect(s.all('SELECT * FROM t')).toHaveLength(1);
    expect(s.get<{ journal_mode: string }>('PRAGMA journal_mode')?.journal_mode).toBe('wal');
    if (posix) expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    s.close();
    s.close();
  });

  it('rolls back failed transactions and flattens nested ones', () => {
    const s = openNodeSqliteStore(path.join(tempDir(), 'i.sqlite'));
    s.exec('CREATE TABLE t(a)');
    expect(() =>
      s.transaction(() => {
        s.run('INSERT INTO t VALUES (1)');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    s.transaction(() => s.transaction(() => s.run('INSERT INTO t VALUES (2)')));
    expect(s.all<{ a: number }>('SELECT a FROM t').map((r) => r.a)).toEqual([2]);
    s.close();
  });

  it('lets read-only readers see commits through WAL and data_version (R5.3)', () => {
    const file = path.join(tempDir(), 'i.sqlite');
    const w = openNodeSqliteStore(file);
    w.exec('CREATE TABLE t(a)');
    const r = openNodeSqliteStore(file, { readOnly: true });
    const v0 = r.dataVersion();
    w.run('INSERT INTO t VALUES (1)');
    expect(r.dataVersion()).not.toBe(v0);
    expect(r.all('SELECT * FROM t')).toHaveLength(1);
    expect(() => r.run('INSERT INTO t VALUES (2)')).toThrow();
    r.close();
    w.close();
  });

  it('uses a rollback journal for build files', () => {
    const s = openNodeSqliteStore(path.join(tempDir(), 'b.sqlite'), { journal: 'delete' });
    expect(s.get<{ journal_mode: string }>('PRAGMA journal_mode')?.journal_mode).toBe('delete');
    s.close();
  });

  it('exposes node:sqlite with FTS5', () => {
    const { DatabaseSync } = loadSqlite();
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE VIRTUAL TABLE f USING fts5(a)');
    db.close();
  });
});

describe('publishBuild (R5.4)', () => {
  const build = (file: string, value: string): void => {
    const s = openNodeSqliteStore(file, { journal: 'delete' });
    s.exec('CREATE TABLE t(v)');
    s.run('INSERT INTO t VALUES (?)', [value]);
    s.close();
  };

  it('renames the build file when there is no live index yet', async () => {
    const dir = tempDir();
    build(path.join(dir, 'index.sqlite.build'), 'new');
    await publishBuild(path.join(dir, 'index.sqlite.build'), path.join(dir, 'index.sqlite'));
    expect(fs.existsSync(path.join(dir, 'index.sqlite.build'))).toBe(false);
    const s = openNodeSqliteStore(path.join(dir, 'index.sqlite'), { readOnly: true });
    expect(s.get<{ v: string }>('SELECT v FROM t')?.v).toBe('new');
    s.close();
  });

  it('switches an open reader atomically and keeps WAL', async () => {
    const dir = tempDir();
    const live = path.join(dir, 'index.sqlite');
    const w = openNodeSqliteStore(live);
    w.exec('CREATE TABLE t(v)');
    w.run('INSERT INTO t VALUES (?)', ['old']);
    w.close();
    const reader = openNodeSqliteStore(live, { readOnly: true });
    expect(reader.get<{ v: string }>('SELECT v FROM t')?.v).toBe('old');
    build(path.join(dir, 'index.sqlite.build'), 'new');
    await publishBuild(path.join(dir, 'index.sqlite.build'), live);
    expect(reader.get<{ v: string }>('SELECT v FROM t')?.v).toBe('new');
    reader.close();
    const check = openNodeSqliteStore(live);
    expect(check.get<{ journal_mode: string }>('PRAGMA journal_mode')?.journal_mode).toBe('wal');
    expect(check.get<{ integrity_check: string }>('PRAGMA integrity_check')?.integrity_check).toBe('ok');
    check.close();
    if (posix) expect(fs.statSync(live).mode & 0o777).toBe(0o600);
  });
});

describe('IndexLock (R5.3)', () => {
  it('admits a single writer and releases', () => {
    const file = path.join(tempDir(), 'index.lock');
    const a = new IndexLock(file);
    const b = new IndexLock(file);
    expect(a.tryAcquire()).toBe(true);
    expect(a.tryAcquire()).toBe(true);
    expect(b.tryAcquire()).toBe(false);
    expect(a.read()?.pid).toBe(process.pid);
    if (posix) expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    b.release();
    expect(fs.existsSync(file)).toBe(true);
    a.release();
    expect(fs.existsSync(file)).toBe(false);
    expect(b.tryAcquire()).toBe(true);
    b.release();
  });

  it('takes over a lock with an old heartbeat or a dead process', () => {
    const file = path.join(tempDir(), 'index.lock');
    let now = 1_000_000;
    const a = new IndexLock(file, { now: () => now });
    const b = new IndexLock(file, { now: () => now });
    expect(a.tryAcquire()).toBe(true);
    now += 29_000;
    expect(b.tryAcquire()).toBe(false);
    now += 2_000;
    expect(b.tryAcquire()).toBe(true);
    expect(a.heartbeat()).toBe(false);
    expect(a.isHeld).toBe(false);
    const c = new IndexLock(file, { now: () => now, isAlive: () => false });
    expect(c.tryAcquire()).toBe(true);
    expect(b.heartbeat()).toBe(false);
  });

  it('treats an unreadable lock file as stale', () => {
    const file = path.join(tempDir(), 'index.lock');
    fs.writeFileSync(file, '{broken');
    const a = new IndexLock(file);
    expect(a.read()).toBeUndefined();
    expect(a.tryAcquire()).toBe(true);
    expect(a.heartbeat()).toBe(true);
  });

  it('creates private files', () => {
    const file = path.join(tempDir(), 'x');
    ensurePrivateFile(file);
    expect(fs.existsSync(file)).toBe(true);
  });
});
