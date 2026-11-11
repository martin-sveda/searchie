import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_ID, copyFixtureCliRoot, FIXTURE_CLI_ROOT, stableFixtureUserDir, tempDir, writeJsonl } from '../test/helpers';
import { cliRootsForEntry, discoverCliWorkspaces, isCliSessionLive, isInside, readStartContext, resumeCommand } from './cli-sources';
import { folderHash, folderKey, folderPathToUri } from './folders';
import { discoverAll, resolveCliRoots, resolveRoots, type SourceSettings } from './sources';
import { parseFlatYaml } from './yaml-lite';

const BASE: SourceSettings = { vscode: false, vscodeInsiders: false, copilotCli: false, emptyWindow: true, additionalSessionRoots: [], excludeWorkspaces: [] };
const FIXTURE_FOLDER = '/home/user/projects/sample-app';

describe('folderKey (R5.21)', () => {
  it('normalizes file URIs, separators, trailing slashes and Windows case', () => {
    expect(folderKey('file:///home/user/projects/sample-app')).toBe(FIXTURE_FOLDER);
    expect(folderKey('/home/user/projects/sample-app/')).toBe(FIXTURE_FOLDER);
    expect(folderKey('/Home/User')).toBe('/Home/User');
    expect(folderKey('C:\\Users\\Dev\\Repo\\')).toBe('c:/users/dev/repo');
    expect(folderKey('file:///c%3A/Users/Dev/Repo')).toBe('c:/users/dev/repo');
    expect(folderKey('C:\\')).toBe('c:/');
    expect(folderKey('\\\\server\\Share\\X')).toBe('//server/share/x');
    expect(folderKey('/')).toBe('/');
  });

  it('keeps non-file URIs as scheme://authority/path and rejects empty input', () => {
    expect(folderKey('vscode-remote://SSH-Remote%2Bbox/home/u/app/')).toBe('vscode-remote://ssh-remote%2bbox/home/u/app');
    expect(folderKey('vscode-vfs://github/Org/Repo')).toBe('vscode-vfs://github/Org/Repo');
    expect(folderKey(undefined)).toBeUndefined();
    expect(folderKey('  ')).toBeUndefined();
  });

  it('hashes to 16 hex chars and builds file URIs', () => {
    expect(folderHash(FIXTURE_FOLDER)).toMatch(/^[0-9a-f]{16}$/);
    expect(folderHash('a')).not.toBe(folderHash('b'));
    expect(folderPathToUri('/home/u/my app#1')).toBe('file:///home/u/my%20app%231');
    expect(folderPathToUri('C:\\Users\\u')).toBe('file:///C:/Users/u');
  });
});

describe('parseFlatYaml (R4.15)', () => {
  it('reads plain, quoted and escaped scalars and skips the rest', () => {
    const y = parseFlatYaml(
      [
        'id: abc # comment',
        'name: "Fix \\"bug\\" \\u00e9\\x21\\n"',
        "branch: 'it''s'",
        'cwd: C:\\Users\\u',
        'empty:',
        'nil: ~',
        'block: |',
        '  multi',
        'flow: [a, b]',
        'anchor: &a x',
        'nested:',
        '  child: 1',
        'bad: "unterminated',
        "bad2: 'x' trailing",
        'bad3: "\\q"',
        'bad4: "\\u12"',
        'id: second',
        '# comment: line',
      ].join('\r\n'),
    );
    expect(Object.fromEntries(y)).toEqual({ id: 'abc', name: 'Fix "bug" é!\n', branch: "it's", cwd: 'C:\\Users\\u' });
  });
});

describe('CLI roots (R3.2, R3.6)', () => {
  const env = { platform: 'linux' as const, home: '/home/u' };

  it('recognises session-state, history-session-state and .copilot entries', () => {
    expect(cliRootsForEntry('/x/session-state/')).toEqual(['/x/session-state/']);
    expect(cliRootsForEntry('/x/history-session-state')).toEqual(['/x/history-session-state']);
    expect(cliRootsForEntry('/x/.copilot', path.posix)).toEqual(['/x/.copilot/session-state', '/x/.copilot/history-session-state']);
    expect(cliRootsForEntry('C:\\u\\.copilot', path.win32)).toEqual(['C:\\u\\.copilot\\session-state', 'C:\\u\\.copilot\\history-session-state']);
    expect(cliRootsForEntry('/x/Code/User')).toBeUndefined();
  });

  it('adds default roots only when enabled, de-duplicates and keeps CLI entries out of VS Code roots', () => {
    const settings = { ...BASE, copilotCli: true, additionalSessionRoots: ['~/.copilot/session-state', '/mnt/session-state', '/mnt/Code/User'] };
    expect(resolveCliRoots(settings, env)).toEqual([
      { dir: '/home/u/.copilot/session-state', additional: false },
      { dir: '/home/u/.copilot/history-session-state', additional: false },
      { dir: '/mnt/session-state', additional: true },
    ]);
    expect(resolveCliRoots({ ...settings, copilotCli: false }, env)).toEqual([{ dir: '/home/u/.copilot/session-state', additional: true }, { dir: '/mnt/session-state', additional: true }]);
    expect(resolveRoots(settings, env).map((r) => r.userDir)).toEqual(['/mnt/Code/User']);
  });
});

describe('discoverCliWorkspaces', () => {
  it('groups the fixture by folder with a hashed id, repository name and R5.22 stamps', async () => {
    const [ws, ...rest] = await discoverCliWorkspaces([{ dir: FIXTURE_CLI_ROOT, additional: true }], []);
    expect(rest).toHaveLength(0);
    expect(ws).toMatchObject({ id: `copilot-cli:${folderHash(FIXTURE_FOLDER)}`, source: 'copilot-cli', name: 'sample-org/sample-app', folder: FIXTURE_FOLDER, folderPath: FIXTURE_FOLDER, uri: `file://${FIXTURE_FOLDER}` });
    const dir = path.join(FIXTURE_CLI_ROOT, CLI_ID);
    const size = fs.statSync(path.join(dir, 'events.jsonl')).size + fs.statSync(path.join(dir, 'workspace.yaml')).size;
    expect(ws!.files).toEqual([expect.objectContaining({ path: path.join(dir, 'events.jsonl'), kind: 'jsonl', size })]);
    expect(ws!.fingerprint).toBe(`cli:1:${ws!.files[0]!.mtimeMs}:${size}`);
    expect(ws!.id).not.toContain('home');
  });

  it('falls back to session.start context, then to a no-folder group; applies excludes; skips dirs without events', async () => {
    const root = copyFixtureCliRoot();
    writeJsonl(path.join(root, 'ctx'), 'events.jsonl', [{ type: 'session.start', data: { sessionId: 'ctx', context: { cwd: '/w/other/' } } }]);
    writeJsonl(path.join(root, 'bare'), 'events.jsonl', [{ type: 'user.message', data: { content: 'x' } }]);
    fs.mkdirSync(path.join(root, 'no-events'));
    fs.writeFileSync(path.join(root, 'stray.txt'), 'x');
    const all = await discoverCliWorkspaces([{ dir: root, additional: true }, { dir: path.join(root, 'missing'), additional: true }], []);
    expect(all.map((w) => w.name).sort()).toEqual(['No folder', 'other', 'sample-org/sample-app']);
    expect(all.find((w) => w.name === 'No folder')).toMatchObject({ id: 'copilot-cli:no-folder', folder: undefined, uri: undefined });
    expect(all.find((w) => w.name === 'other')!.folder).toBe('/w/other');
    const excluded = await discoverCliWorkspaces([{ dir: root, additional: true }], ['**/sample-app']);
    expect(excluded.map((w) => w.name).sort()).toEqual(['No folder', 'other']);
  });

  it('changes the fingerprint when workspace.yaml changes and moves a session whose folder changes (R5.22)', async () => {
    const root = copyFixtureCliRoot();
    const [before] = await discoverCliWorkspaces([{ dir: root, additional: true }], []);
    fs.appendFileSync(path.join(root, CLI_ID, 'workspace.yaml'), 'summary: x\n');
    const [after] = await discoverCliWorkspaces([{ dir: root, additional: true }], []);
    expect(after!.fingerprint).not.toBe(before!.fingerprint);
    const yaml = path.join(root, CLI_ID, 'workspace.yaml');
    fs.writeFileSync(yaml, fs.readFileSync(yaml, 'utf8').replaceAll(FIXTURE_FOLDER, '/w/moved').replace(/^repository:.*$/m, ''));
    const [moved] = await discoverCliWorkspaces([{ dir: root, additional: true }], []);
    expect(moved).toMatchObject({ id: `copilot-cli:${folderHash('/w/moved')}`, name: 'moved' });
  });

  it('shares the folder key with the VS Code fixture workspace (R7.27 merge)', async () => {
    const all = await discoverAll({ ...BASE, additionalSessionRoots: [stableFixtureUserDir(), FIXTURE_CLI_ROOT] });
    const groups = all.filter((w) => w.folder === FIXTURE_FOLDER).map((w) => w.source).sort();
    expect(groups).toEqual(['copilot-cli', 'vscode']);
  });

  it('reads the start context only from a leading session.start line', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'events.jsonl'), '{"type":"session.start",broken\n');
    expect(await readStartContext(dir)).toEqual({});
    expect(await readStartContext(path.join(dir, 'missing'))).toEqual({});
  });
});

describe('R8.5 helpers', () => {
  it('builds the resume command only for shell-safe ids', () => {
    expect(resumeCommand(CLI_ID)).toBe(`copilot --resume=${CLI_ID}`);
    for (const bad of ['', '-rf', 'a b', 'a;rm', '$(x)', 'a'.repeat(200)]) expect(resumeCommand(bad)).toBeUndefined();
  });

  it('checks containment per platform', () => {
    expect(isInside('/h/.copilot/session-state/x', '/h/.copilot/session-state', false)).toBe(true);
    expect(isInside('/h/.copilot/session-state', '/h/.copilot/session-state', false)).toBe(false);
    expect(isInside('/h/.copilot/session-state-x/y', '/h/.copilot/session-state', false)).toBe(false);
    expect(isInside('C:\\Users\\U\\.copilot\\session-state\\x', 'c:\\users\\u\\.copilot\\session-state', true)).toBe(true);
  });
});

describe('isCliSessionLive (R8.5)', () => {
  const dir = path.join(FIXTURE_CLI_ROOT, CLI_ID);

  it('checks the pid for local sessions and treats any lock as live for additional roots', () => {
    expect(isCliSessionLive(dir, true, (pid) => pid === 12345)).toBe(true);
    expect(isCliSessionLive(dir, true, () => false)).toBe(false);
    expect(isCliSessionLive(dir, false, () => false)).toBe(true);
    expect(isCliSessionLive(tempDir(), false, () => true)).toBe(false);
    expect(isCliSessionLive(path.join(dir, 'missing'), false, () => true)).toBe(false);
  });
});
