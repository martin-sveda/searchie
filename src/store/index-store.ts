/** Storage abstraction (R5.2): a SQLite connection with FTS5. Engines: node:sqlite (default), later fallbacks. */

export type SqlValue = string | number | bigint | null | Uint8Array;
export type SqlParams = readonly SqlValue[];

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

export interface IndexStore {
  readonly path: string;
  readonly readOnly: boolean;
  exec(sql: string): void;
  run(sql: string, params?: SqlParams): RunResult;
  get<T>(sql: string, params?: SqlParams): T | undefined;
  all<T>(sql: string, params?: SqlParams): T[];
  /** Runs `fn` in one write transaction (BEGIN IMMEDIATE … COMMIT, ROLLBACK on throw). */
  transaction<T>(fn: () => T): T;
  /** `PRAGMA data_version` – changes when another connection commits (R5.3). */
  dataVersion(): number;
  close(): void;
}

export interface OpenOptions {
  readOnly?: boolean;
  /** WAL for the live index, rollback journal for a cold build file (R5.4). */
  journal?: 'wal' | 'delete';
}

export type StoreFactory = (path: string, options?: OpenOptions) => IndexStore;
