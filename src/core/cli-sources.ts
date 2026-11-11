import fs from 'node:fs';
import path from 'node:path';
import { workspaceKey } from './ids';
import { folderHash, folderKey, folderPathToUri } from './folders';
import { matchesAnyGlob } from './text';
import { parseFlatYaml } from './yaml-lite';

/** Copilot CLI roots and session discovery (SPEC R3.2, R3.6, R5.21, R5.22). Read-only. */

export interface CliRoot {
  /** A `session-state` (or legacy `history-session-state`) directory. */
  dir: string;
  additional: boolean;
}

export const CLI_ROOT_NAMES = ['session-state', 'history-session-state'] as const;
export const CLI_EVENTS = 'events.jsonl';
export const CLI_WORKSPACE = 'workspace.yaml';
export const CLI_NO_FOLDER = 'no-folder';
const MAX_META_BYTES = 64 * 1024;

/** R3.2 – CLI root dirs for an additional-root entry, or undefined when the entry is a VS Code `User/` dir. */
export function cliRootsForEntry(dir: string, p: path.PlatformPath = path): string[] | undefined {
  const base = p.basename(dir.replace(/[\\/]+$/, ''));
  if ((CLI_ROOT_NAMES as readonly string[]).includes(base)) return [dir];
  if (base === '.copilot') return CLI_ROOT_NAMES.map((n) => p.join(dir, n));
  return undefined;
}

export interface CliSessionHint {
  sessionId?: string;
  /** `git_root` → `cwd`, as written by the CLI. */
  folderPath?: string;
  repository?: string;
  name?: string;
  createdAt?: string;
  updatedAt?: string;
}

async function readHead(file: string, max = MAX_META_BYTES): Promise<string | undefined> {
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(file, 'r');
    const buf = Buffer.alloc(max);
    const { bytesRead } = await handle.read(buf, 0, max, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

/** `workspace.yaml` fields (R4.15). */
export async function readWorkspaceYaml(sessionDir: string): Promise<CliSessionHint> {
  const text = await readHead(path.join(sessionDir, CLI_WORKSPACE));
  if (text === undefined) return {};
  const y = parseFlatYaml(text);
  return {
    sessionId: y.get('id'),
    folderPath: y.get('git_root') || y.get('cwd'),
    repository: y.get('repository'),
    name: y.get('name'),
    createdAt: y.get('created_at'),
    updatedAt: y.get('updated_at'),
  };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** Workspace from the first `session.start` event in the first 64 KB (R4.11 fallback without `workspace.yaml`). */
export async function readStartContext(sessionDir: string): Promise<CliSessionHint> {
  const text = await readHead(path.join(sessionDir, CLI_EVENTS));
  if (!text) return {};
  for (const line of text.split('\n')) {
    if (!line.startsWith('{"type":"session.start"')) continue;
    try {
      const e: unknown = JSON.parse(line);
      const d = isObj(e) && isObj(e.data) ? e.data : {};
      const ctx = isObj(d.context) ? d.context : {};
      return { sessionId: str(d.sessionId), folderPath: str(ctx.gitRoot) ?? str(ctx.cwd), repository: str(ctx.repository) };
    } catch {
      return {};
    }
  }
  return {};
}

const hintCache = new Map<string, { stamp: string; hint: CliSessionHint }>();

async function sessionHint(sessionDir: string, stamp: string): Promise<CliSessionHint> {
  const cached = hintCache.get(sessionDir);
  if (cached?.stamp === stamp) return cached.hint;
  const yaml = await readWorkspaceYaml(sessionDir);
  const hint = yaml.folderPath ? yaml : { ...yaml, ...(await readStartContext(sessionDir)), name: yaml.name, createdAt: yaml.createdAt, updatedAt: yaml.updatedAt };
  hintCache.set(sessionDir, { stamp, hint });
  return hint;
}

export interface CliDiscoveredFile {
  path: string;
  source: 'copilot-cli';
  workspaceId: string;
  kind: 'jsonl';
  /** Max of `events.jsonl` and `workspace.yaml` (R5.22). */
  mtimeMs: number;
  /** Sum of both files (R5.22). */
  size: number;
}

export interface CliDiscoveredWorkspace {
  id: string;
  source: 'copilot-cli';
  name: string;
  uri?: string;
  folderPath?: string;
  folder?: string;
  dir: string;
  fingerprint: string;
  files: CliDiscoveredFile[];
}

async function statOrUndefined(p: string): Promise<fs.Stats | undefined> {
  try {
    return await fs.promises.stat(p);
  } catch {
    return undefined;
  }
}

/** Groups CLI sessions by folder key (R5.21); excluded folders are skipped (R3.3). */
export async function discoverCliWorkspaces(roots: readonly CliRoot[], excludeWorkspaces: readonly string[]): Promise<CliDiscoveredWorkspace[]> {
  const byId = new Map<string, CliDiscoveredWorkspace & { maxMtime: number; totalSize: number }>();
  for (const root of roots) {
    let names: string[];
    try {
      names = (await fs.promises.readdir(root.dir)).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const dir = path.join(root.dir, name);
      const events = await statOrUndefined(path.join(dir, CLI_EVENTS));
      if (!events?.isFile()) continue;
      const yaml = await statOrUndefined(path.join(dir, CLI_WORKSPACE));
      const mtimeMs = Math.trunc(Math.max(events.mtimeMs, yaml?.isFile() ? yaml.mtimeMs : 0));
      const size = events.size + (yaml?.isFile() ? yaml.size : 0);
      const hint = await sessionHint(dir, `${mtimeMs}:${size}`);
      const key = folderKey(hint.folderPath);
      if (hint.folderPath && matchesAnyGlob(hint.folderPath, excludeWorkspaces)) continue;
      const id = workspaceKey('copilot-cli', key ? folderHash(key) : CLI_NO_FOLDER);
      let ws = byId.get(id);
      if (!ws) {
        const base = hint.folderPath?.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
        ws = {
          id,
          source: 'copilot-cli',
          name: hint.repository || base || 'No folder',
          uri: hint.folderPath ? folderPathToUri(hint.folderPath) : undefined,
          folderPath: hint.folderPath,
          folder: key,
          dir: root.dir,
          fingerprint: '',
          files: [],
          maxMtime: 0,
          totalSize: 0,
        };
        byId.set(id, ws);
      } else if (!ws.name.includes('/') && hint.repository) {
        ws.name = hint.repository;
      }
      ws.files.push({ path: path.join(dir, CLI_EVENTS), source: 'copilot-cli', workspaceId: id, kind: 'jsonl', mtimeMs, size });
      ws.maxMtime = Math.max(ws.maxMtime, mtimeMs);
      ws.totalSize += size;
    }
  }
  return [...byId.values()].map(({ maxMtime, totalSize, ...ws }) => ({ ...ws, fingerprint: `cli:${ws.files.length}:${maxMtime}:${totalSize}` }));
}

const INUSE = /^inuse\.(\d+)\.lock$/;

/**
 * R8.5 – a CLI session is live when its directory holds an `inuse.<pid>.lock` whose process is alive. For sessions
 * from another machine (`local = false`) the pid can't be checked, so any lock counts as live.
 */
export function isCliSessionLive(sessionDir: string, local: boolean, isAlive: (pid: number) => boolean): boolean {
  let names: string[];
  try {
    names = fs.readdirSync(sessionDir);
  } catch {
    return false;
  }
  return names.some((n) => {
    const m = INUSE.exec(n);
    if (!m) return false;
    return !local || isAlive(Number(m[1]));
  });
}

const SESSION_ID = /^[A-Za-z0-9][\w.-]{0,127}$/;

/** R8.5 – `copilot --resume=<id>`, or undefined for an id that is not safe to paste into a shell. */
export function resumeCommand(sessionId: string): string | undefined {
  return SESSION_ID.test(sessionId) ? `copilot --resume=${sessionId}` : undefined;
}

/** True when `file` lies inside `dir` (case-insensitive on Windows). */
export function isInside(file: string, dir: string, win = process.platform === 'win32'): boolean {
  const p = win ? path.win32 : path.posix;
  const rel = p.relative(win ? dir.toLowerCase() : dir, win ? file.toLowerCase() : file);
  return rel !== '' && !rel.startsWith('..') && !p.isAbsolute(rel);
}
