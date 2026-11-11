import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Paths to the anonymized fixtures (src/test/fixtures/README.md) and temp-file helpers for tests. */

export const FIXTURES = path.resolve(__dirname, 'fixtures');
export const FIXTURE_USER_DIR = path.join(FIXTURES, 'vscode');
export const WS_FOLDER_HASH = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
export const WS_FILE_HASH = 'b2c3d4e5f60718293a4b5c6d7e8f90a1';
export const MAIN_ID = '11111111-1111-4111-8111-111111111111';
export const LEGACY_ID = '22222222-2222-4222-8222-222222222222';
export const EMPTY_WINDOW_ID = '33333333-3333-4333-8333-333333333333';

export const MAIN_JSONL = path.join(FIXTURE_USER_DIR, 'workspaceStorage', WS_FOLDER_HASH, 'chatSessions', `${MAIN_ID}.jsonl`);
export const MAIN_COPY_JSONL = path.join(FIXTURE_USER_DIR, 'workspaceStorage', WS_FILE_HASH, 'chatSessions', `${MAIN_ID}.jsonl`);
export const LEGACY_JSON = path.join(FIXTURE_USER_DIR, 'workspaceStorage', WS_FOLDER_HASH, 'chatSessions', `${LEGACY_ID}.json`);
export const EMPTY_WINDOW_JSONL = path.join(FIXTURE_USER_DIR, 'globalStorage', 'emptyWindowChatSessions', `${EMPTY_WINDOW_ID}.jsonl`);

export const CLI_ID = '44444444-4444-4444-8444-444444444444';
export const FIXTURE_CLI_ROOT = path.join(FIXTURES, 'cli', 'session-state');
export const CLI_EVENTS = path.join(FIXTURE_CLI_ROOT, CLI_ID, 'events.jsonl');

/** Text that the fixtures place in attachment content and tool output (R4.8, R4.9). */
export const NEVER_INDEXED = 'must never be indexed';

export function tempDir(prefix = 'searchie-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeJsonl(dir: string, name: string, entries: readonly unknown[], extraRaw: readonly string[] = []): string {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [...entries.map((e) => JSON.stringify(e)), ...extraRaw].join('\n') + '\n');
  return file;
}

/** Fixed mtime for fixture copies: git doesn't preserve mtimes, and R5.19 picks the newest duplicate copy. */
export const FIXTURE_MTIME = new Date('2026-01-16T00:00:00Z');

function setMtimes(dir: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) fs.utimesSync(path.join(entry.parentPath, entry.name), FIXTURE_MTIME, FIXTURE_MTIME);
  }
}

/** Copies the fixture `User/` dir into a temp dir (equal mtimes, so the duplicate tie-break is deterministic). */
export function copyFixtureUserDir(): string {
  const dir = tempDir();
  fs.cpSync(FIXTURE_USER_DIR, path.join(dir, 'User'), { recursive: true });
  setMtimes(path.join(dir, 'User'));
  return path.join(dir, 'User');
}

/** Copies the CLI `session-state/` fixture root into a temp dir with fixed mtimes. */
export function copyFixtureCliRoot(): string {
  const dir = path.join(tempDir(), 'session-state');
  fs.cpSync(FIXTURE_CLI_ROOT, dir, { recursive: true });
  setMtimes(dir);
  return dir;
}

let stableCopy: string | undefined;

/** A read-only-by-convention fixture copy shared by tests that only index (never modify) the fixtures. */
export function stableFixtureUserDir(): string {
  stableCopy ??= copyFixtureUserDir();
  return stableCopy;
}

export function placeholderRequest(i: number, text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: `request_${i}`,
    timestamp: 1_768_000_000_000 + i * 60_000,
    modelId: 'copilot/placeholder-model',
    message: { text },
    response: [],
    ...extra,
  };
}
