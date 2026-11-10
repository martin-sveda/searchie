import fs from 'node:fs';
import path from 'node:path';
import { EMPTY_WINDOW, type SourceId, workspaceKey } from './ids';
import { fileUriToPath, matchesAnyGlob } from './text';

/** Source and workspace discovery for VS Code Stable / Insiders (SPEC §3). */

export type VsCodeSource = Extract<SourceId, 'vscode' | 'vscode-insiders'>;

export interface VsCodeRoot {
  source: VsCodeSource;
  /** A VS Code `User/` directory (contains `workspaceStorage/` and/or `globalStorage/`). */
  userDir: string;
  additional: boolean;
}

export interface SourceSettings {
  vscode: boolean;
  vscodeInsiders: boolean;
  emptyWindow: boolean;
  additionalSessionRoots: readonly string[];
  excludeWorkspaces: readonly string[];
}

export interface PlatformEnv {
  platform: NodeJS.Platform;
  home: string;
  appData?: string;
  xdgConfigHome?: string;
}

export function currentPlatformEnv(): PlatformEnv {
  return {
    platform: process.platform,
    home: process.env.HOME || process.env.USERPROFILE || '',
    appData: process.env.APPDATA,
    xdgConfigHome: process.env.XDG_CONFIG_HOME,
  };
}

/** R3.2 – an additional root is Insiders when its path mentions "insiders". */
export function sourceForPath(p: string): VsCodeSource {
  return /insiders/i.test(p) ? 'vscode-insiders' : 'vscode';
}

/** Default `User/` dirs per OS (adapted concept from Searchie prototype `findVsCodeDirs`). Existence is not checked. */
export function defaultUserDirs(env: PlatformEnv): { source: VsCodeSource; userDir: string }[] {
  const p = env.platform === 'win32' ? path.win32 : path.posix;
  const editions: [VsCodeSource, string][] = [
    ['vscode', 'Code'],
    ['vscode-insiders', 'Code - Insiders'],
  ];
  const out: { source: VsCodeSource; userDir: string }[] = [];
  for (const [source, folder] of editions) {
    if (env.platform === 'darwin') {
      out.push({ source, userDir: p.join(env.home, 'Library', 'Application Support', folder, 'User') });
    } else if (env.platform === 'win32') {
      const appData = env.appData || p.join(env.home, 'AppData', 'Roaming');
      out.push({ source, userDir: p.join(appData, folder, 'User') });
    } else {
      const config = env.xdgConfigHome || p.join(env.home, '.config');
      out.push({ source, userDir: p.join(config, folder, 'User') });
    }
  }
  if (env.platform !== 'win32' && env.home) {
    out.push(
      { source: 'vscode', userDir: p.join(env.home, '.vscode-server', 'data', 'User') },
      { source: 'vscode-insiders', userDir: p.join(env.home, '.vscode-server-insiders', 'data', 'User') },
    );
  }
  return out;
}

/** R3.1/R3.2 – enabled default roots plus additional roots (always included), de-duplicated. */
export function resolveRoots(settings: SourceSettings, env: PlatformEnv = currentPlatformEnv()): VsCodeRoot[] {
  const roots: VsCodeRoot[] = [];
  const seen = new Set<string>();
  const add = (root: VsCodeRoot): void => {
    const norm = env.platform === 'win32' ? root.userDir.toLowerCase() : root.userDir;
    if (seen.has(norm)) return;
    seen.add(norm);
    roots.push(root);
  };
  for (const r of defaultUserDirs(env)) {
    if (r.source === 'vscode' ? settings.vscode : settings.vscodeInsiders) add({ ...r, additional: false });
  }
  const p = env.platform === 'win32' ? path.win32 : path.posix;
  for (const raw of settings.additionalSessionRoots) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    let dir = raw.trim();
    if (dir === '~' || dir.startsWith('~/') || dir.startsWith('~\\')) dir = p.join(env.home, dir.slice(1));
    add({ source: sourceForPath(dir), userDir: p.resolve(dir), additional: true });
  }
  return roots;
}

export interface DiscoveredFile {
  path: string;
  source: VsCodeSource;
  workspaceId: string;
  kind: 'jsonl' | 'json';
  mtimeMs: number;
  size: number;
}

export interface DiscoveredWorkspace {
  id: string;
  source: VsCodeSource;
  name: string;
  uri?: string;
  folderPath?: string;
  /** Directory holding the session files. */
  dir: string;
  fingerprint: string;
  files: DiscoveredFile[];
}

export interface WorkspaceIdentity {
  name: string;
  uri?: string;
  folderPath?: string;
}

/** Reads `workspace.json` (`{ folder }` or `{ workspace }`); falls back to the storage hash. */
export function readWorkspaceIdentity(storageDir: string): WorkspaceIdentity {
  const hash = path.basename(storageDir);
  try {
    const data: unknown = JSON.parse(fs.readFileSync(path.join(storageDir, 'workspace.json'), 'utf8'));
    if (typeof data === 'object' && data !== null) {
      const d = data as Record<string, unknown>;
      const uri = typeof d.folder === 'string' ? d.folder : typeof d.workspace === 'string' ? d.workspace : undefined;
      if (uri) {
        const folderPath = uriToFolderPath(uri);
        const base = folderPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || hash;
        const isWorkspaceFile = typeof d.workspace === 'string';
        const name = isWorkspaceFile ? `${base.replace(/\.code-workspace$/i, '')} (workspace)` : base;
        return { name, uri, folderPath };
      }
    }
  } catch {
    // missing or unreadable workspace.json
  }
  return { name: hash };
}

function uriToFolderPath(uri: string): string {
  if (uri.startsWith('file://')) return fileUriToPath(uri);
  try {
    return decodeURIComponent(new URL(uri).pathname);
  } catch {
    return uri;
  }
}

const SESSION_FILE = /\.(jsonl|json)$/i;

async function listSessionFiles(dir: string, source: VsCodeSource, workspaceId: string): Promise<{ files: DiscoveredFile[]; fingerprint: string } | null> {
  let dirStat: fs.Stats;
  let names: string[];
  try {
    dirStat = await fs.promises.stat(dir);
    if (!dirStat.isDirectory()) return null;
    names = await fs.promises.readdir(dir);
  } catch {
    return null;
  }
  const files: DiscoveredFile[] = [];
  let maxMtime = 0;
  let totalSize = 0;
  for (const name of names.sort()) {
    const m = SESSION_FILE.exec(name);
    if (!m) continue;
    const full = path.join(dir, name);
    try {
      const st = await fs.promises.stat(full);
      if (!st.isFile()) continue;
      files.push({ path: full, source, workspaceId, kind: m[1]!.toLowerCase() as 'jsonl' | 'json', mtimeMs: Math.trunc(st.mtimeMs), size: st.size });
      maxMtime = Math.max(maxMtime, Math.trunc(st.mtimeMs));
      totalSize += st.size;
    } catch {
      // file vanished between readdir and stat
    }
  }
  // R5.20 – dir mtime + count + max file mtime + total size (appends change only the last two).
  return { files, fingerprint: `${Math.trunc(dirStat.mtimeMs)}:${files.length}:${maxMtime}:${totalSize}` };
}

/** Lists every workspace (and the empty-window pseudo-workspace) with its session files. Read-only (R3.4). */
export async function discoverWorkspaces(roots: readonly VsCodeRoot[], settings: Pick<SourceSettings, 'emptyWindow' | 'excludeWorkspaces'>): Promise<DiscoveredWorkspace[]> {
  const byId = new Map<string, DiscoveredWorkspace>();
  const add = (ws: DiscoveredWorkspace): void => {
    const existing = byId.get(ws.id);
    if (!existing) {
      byId.set(ws.id, ws);
      return;
    }
    // Same storage hash under two roots (e.g. an additional root that mirrors a default one).
    const known = new Set(existing.files.map((f) => f.path));
    existing.files.push(...ws.files.filter((f) => !known.has(f.path)));
    existing.fingerprint += `|${ws.fingerprint}`;
  };
  for (const root of roots) {
    const storage = path.join(root.userDir, 'workspaceStorage');
    let hashes: string[] = [];
    try {
      hashes = (await fs.promises.readdir(storage)).sort();
    } catch {
      // missing root (R3.1)
    }
    for (const hash of hashes) {
      const storageDir = path.join(storage, hash);
      const dir = path.join(storageDir, 'chatSessions');
      const id = workspaceKey(root.source, hash);
      const listed = await listSessionFiles(dir, root.source, id);
      if (!listed) continue;
      const identity = readWorkspaceIdentity(storageDir);
      if (identity.folderPath && matchesAnyGlob(identity.folderPath, settings.excludeWorkspaces)) continue;
      add({ id, source: root.source, ...identity, dir, ...listed });
    }
    if (settings.emptyWindow) {
      const dir = path.join(root.userDir, 'globalStorage', 'emptyWindowChatSessions');
      const id = workspaceKey(root.source, EMPTY_WINDOW);
      const listed = await listSessionFiles(dir, root.source, id);
      if (listed) add({ id, source: root.source, name: 'Empty window', dir, ...listed });
    }
  }
  return [...byId.values()];
}
