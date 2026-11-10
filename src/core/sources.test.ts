import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { copyFixtureUserDir, FIXTURE_USER_DIR, MAIN_ID, tempDir, WS_FILE_HASH, WS_FOLDER_HASH } from '../test/helpers';
import { RawVsCodeSessionSchema, sessionKey, SessionMetaSchema, workspaceKey } from './model';
import { defaultUserDirs, discoverWorkspaces, readWorkspaceIdentity, resolveRoots, type SourceSettings, sourceForPath } from './sources';

const BASE: SourceSettings = { vscode: true, vscodeInsiders: true, emptyWindow: true, additionalSessionRoots: [], excludeWorkspaces: [] };

describe('defaultUserDirs', () => {
  it('uses Application Support on macOS', () => {
    expect(defaultUserDirs({ platform: 'darwin', home: '/Users/u' }).slice(0, 2)).toEqual([
      { source: 'vscode', userDir: '/Users/u/Library/Application Support/Code/User' },
      { source: 'vscode-insiders', userDir: '/Users/u/Library/Application Support/Code - Insiders/User' },
    ]);
  });

  it('uses %APPDATA% on Windows and has no server dirs', () => {
    const dirs = defaultUserDirs({ platform: 'win32', home: 'C:\\Users\\u', appData: 'C:\\Users\\u\\AppData\\Roaming' });
    expect(dirs).toEqual([
      { source: 'vscode', userDir: 'C:\\Users\\u\\AppData\\Roaming\\Code\\User' },
      { source: 'vscode-insiders', userDir: 'C:\\Users\\u\\AppData\\Roaming\\Code - Insiders\\User' },
    ]);
    expect(defaultUserDirs({ platform: 'win32', home: 'C:\\Users\\u' })[0]!.userDir).toBe('C:\\Users\\u\\AppData\\Roaming\\Code\\User');
  });

  it('uses ~/.config (or XDG_CONFIG_HOME) and VS Code Server dirs on Linux', () => {
    const dirs = defaultUserDirs({ platform: 'linux', home: '/home/u' }).map((d) => d.userDir);
    expect(dirs).toEqual([
      '/home/u/.config/Code/User',
      '/home/u/.config/Code - Insiders/User',
      '/home/u/.vscode-server/data/User',
      '/home/u/.vscode-server-insiders/data/User',
    ]);
    expect(defaultUserDirs({ platform: 'linux', home: '/home/u', xdgConfigHome: '/xdg' })[0]!.userDir).toBe('/xdg/Code/User');
  });
});

describe('resolveRoots', () => {
  const env = { platform: 'linux' as const, home: '/home/u' };

  it('honours source toggles but always includes additional roots', () => {
    const roots = resolveRoots({ ...BASE, vscode: false, vscodeInsiders: false, additionalSessionRoots: ['/mnt/wsl/Code - Insiders/User', '~/other/User', ' ', 7 as unknown as string] }, env);
    expect(roots).toEqual([
      { source: 'vscode-insiders', userDir: '/mnt/wsl/Code - Insiders/User', additional: true },
      { source: 'vscode', userDir: '/home/u/other/User', additional: true },
    ]);
  });

  it('de-duplicates roots', () => {
    const roots = resolveRoots({ ...BASE, vscodeInsiders: false, additionalSessionRoots: ['/home/u/.config/Code/User'] }, env);
    expect(roots.filter((r) => r.userDir === '/home/u/.config/Code/User')).toHaveLength(1);
  });

  it('infers Insiders from the path', () => {
    expect(sourceForPath('/x/code-insiders/User')).toBe('vscode-insiders');
    expect(sourceForPath('/x/Code/User')).toBe('vscode');
  });
});

describe('discoverWorkspaces on the fixtures', () => {
  const roots = resolveRoots({ ...BASE, vscode: false, vscodeInsiders: false, additionalSessionRoots: [FIXTURE_USER_DIR] });

  it('finds the folder workspace, the .code-workspace and the empty window', async () => {
    const ws = await discoverWorkspaces(roots, BASE);
    expect(ws.map((w) => [w.id, w.name, w.files.length])).toEqual([
      [`vscode:${WS_FOLDER_HASH}`, 'sample-app', 2],
      [`vscode:${WS_FILE_HASH}`, 'sample-app (workspace)', 1],
      ['vscode:empty-window', 'Empty window', 1],
    ]);
    const folder = ws[0]!;
    expect(folder.uri).toBe('file:///home/user/projects/sample-app');
    expect(folder.folderPath).toBe('/home/user/projects/sample-app');
    expect(folder.files.map((f) => f.kind).sort()).toEqual(['json', 'jsonl']);
    expect(folder.fingerprint.split(':')).toHaveLength(4);
    expect(ws[1]!.files[0]!.path.endsWith(`${MAIN_ID}.jsonl`)).toBe(true);
  });

  it('applies excludeWorkspaces globs and the empty-window toggle', async () => {
    const ws = await discoverWorkspaces(roots, { emptyWindow: false, excludeWorkspaces: ['sample-app'] });
    expect(ws.map((w) => w.name)).toEqual(['sample-app (workspace)']);
  });

  it('skips missing roots silently (R3.1)', async () => {
    const ws = await discoverWorkspaces([{ source: 'vscode', userDir: '/definitely/missing/User', additional: true }], BASE);
    expect(ws).toEqual([]);
  });

  it('changes the fingerprint when a session file is appended to (R5.20)', async () => {
    const userDir = copyFixtureUserDir();
    const r = [{ source: 'vscode' as const, userDir, additional: true }];
    const before = (await discoverWorkspaces(r, BASE))[0]!.fingerprint;
    fs.appendFileSync((await discoverWorkspaces(r, BASE))[0]!.files[0]!.path, '\n');
    const after = (await discoverWorkspaces(r, BASE))[0]!.fingerprint;
    expect(after).not.toBe(before);
  });

  it('merges a workspace that appears under two roots', async () => {
    const userDir = copyFixtureUserDir();
    const r = [
      { source: 'vscode' as const, userDir, additional: true },
      { source: 'vscode' as const, userDir: FIXTURE_USER_DIR, additional: true },
    ];
    const ws = await discoverWorkspaces(r, BASE);
    expect(ws).toHaveLength(3);
    expect(ws[0]!.files).toHaveLength(4);
  });

  it('ignores storage dirs without chatSessions and non-session files', async () => {
    const userDir = copyFixtureUserDir();
    fs.mkdirSync(path.join(userDir, 'workspaceStorage', 'nochat'), { recursive: true });
    const chat = path.join(userDir, 'workspaceStorage', WS_FOLDER_HASH, 'chatSessions');
    fs.writeFileSync(path.join(chat, 'notes.txt'), 'x');
    fs.mkdirSync(path.join(chat, 'dir.jsonl'));
    const ws = await discoverWorkspaces([{ source: 'vscode', userDir, additional: true }], BASE);
    expect(ws).toHaveLength(3);
    expect(ws[0]!.files).toHaveLength(2);
  });
});

describe('readWorkspaceIdentity', () => {
  it('handles remote URIs, missing and broken workspace.json', () => {
    const dir = tempDir();
    const remote = path.join(dir, 'remote');
    fs.mkdirSync(remote);
    fs.writeFileSync(path.join(remote, 'workspace.json'), JSON.stringify({ folder: 'vscode-remote://ssh-remote%2Bhost/home/u/proj%20x' }));
    expect(readWorkspaceIdentity(remote)).toMatchObject({ name: 'proj x', folderPath: '/home/u/proj x' });
    const broken = path.join(dir, 'broken');
    fs.mkdirSync(broken);
    fs.writeFileSync(path.join(broken, 'workspace.json'), '{');
    expect(readWorkspaceIdentity(broken)).toEqual({ name: 'broken' });
    const none = path.join(dir, 'none');
    fs.mkdirSync(none);
    fs.writeFileSync(path.join(none, 'workspace.json'), '{"other":1}');
    expect(readWorkspaceIdentity(none)).toEqual({ name: 'none' });
  });
});

describe('model', () => {
  it('validates leniently (R4.6)', () => {
    expect(RawVsCodeSessionSchema.safeParse({ sessionId: 'a', requests: [], extra: 1, customTitle: 5 }).success).toBe(true);
    expect(RawVsCodeSessionSchema.safeParse({ sessionId: '', requests: [] }).success).toBe(false);
    expect(RawVsCodeSessionSchema.safeParse({ sessionId: 'a' }).success).toBe(false);
  });

  it('builds keys and validates SessionMeta', () => {
    expect(sessionKey('vscode', 'x')).toBe('vscode:x');
    expect(workspaceKey('vscode-insiders', 'h')).toBe('vscode-insiders:h');
    expect(SessionMetaSchema.safeParse({ key: 'k' }).success).toBe(false);
  });
});
