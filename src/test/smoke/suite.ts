import fs from 'node:fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import * as vscode from 'vscode';
import type { SearchieApi } from '../../extension';
import type { SessionListItem } from '../../store/index-db';
import type { TreeNode } from '../../ui/tree';

/** Runs inside the extension host (no mocha): activation, tree from fixtures, search, node:sqlite in the worker, N1/N8. */

const MAIN_ID = '11111111-1111-4111-8111-111111111111';
const results: Record<string, unknown> = {};

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${message}`);
}

async function waitFor<T>(fn: () => T | Promise<T>, ok: (v: T) => boolean, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function collectSessions(api: SearchieApi, node?: TreeNode): Promise<SessionListItem[]> {
  const out: SessionListItem[] = [];
  for (const child of await api.tree.getChildren(node)) {
    if (child.kind === 'session') out.push(child.session);
    else if (child.kind === 'workspace' || child.kind === 'date') out.push(...(await collectSessions(api, child)));
  }
  return out;
}

/** Default keybindings (core + built-in extensions) bound to the same key as searchie.search. */
async function keybindingConflicts(): Promise<string[]> {
  await vscode.commands.executeCommand('workbench.action.openDefaultKeybindingsFile');
  const doc = await waitFor(() => vscode.window.activeTextEditor?.document, (d) => d !== undefined && d.getText().includes('"key"'));
  const key = process.platform === 'darwin' ? 'shift+alt+cmd+f' : 'ctrl+shift+alt+f';
  const conflicts: string[] = [];
  const re = /\{\s*"key":\s*"([^"]+)",\s*"command":\s*"([^"]+)"/g;
  for (const m of doc!.getText().matchAll(re)) if (m[1] === key && m[2] !== 'searchie.search') conflicts.push(m[2]!);
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  return conflicts;
}

export async function run(): Promise<void> {
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  const ext = vscode.extensions.getExtension<SearchieApi>('searchie.searchie');
  assert(ext, 'extension present');
  const api = await ext.activate();
  results.vscodeVersion = vscode.version;
  results.nodeVersion = process.versions.node;
  results.activationMs = Math.round(api.activationMs * 10) / 10;

  await api.service.start();
  const status = await waitFor(() => api.service.currentStatus, (s) => s.state === 'idle' && s.sessions === 3);
  results.indexedSessions = status.sessions;
  results.role = status.role;

  const sessions = await collectSessions(api);
  assert(sessions.length === 3, `tree shows 3 sessions (got ${sessions.length})`);
  const top = await api.tree.getChildren();
  assert(top.some((n) => n.kind === 'summary'), 'tree has a summary node');
  results.treeSessions = sessions.length;

  const found = await api.service.search({ query: 'clenu' });
  assert(found.results.length === 1 && found.results[0]!.session.id === MAIN_ID, 'search finds the diacritics fixture');
  results.searchHits = found.results.length;

  // The searchie.search command end to end: Quick Pick with a query, accept the first item.
  const opened = new Promise<SessionListItem>((resolve) => {
    const record = (s: SessionListItem): Promise<void> => {
      resolve(s);
      return Promise.resolve();
    };
    api.setActions({ open: record, preview: record, openWorkspaceInNewWindow: record });
  });
  void vscode.commands.executeCommand('searchie.search', { query: 'parser' });
  await new Promise((r) => setTimeout(r, 1500));
  await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
  const accepted = await Promise.race([opened, new Promise<undefined>((r) => setTimeout(() => r(undefined), 5000))]);
  assert(accepted?.id === MAIN_ID, 'searchie.search Quick Pick returns the expected session');
  results.quickPick = 'ok';

  for (let i = 0; i < 20; i++) await api.service.search({ query: i % 2 ? 'placeholder' : 'refact*' });
  await vscode.commands.executeCommand('searchie.refresh');
  loop.disable();
  results.eventLoopDelayMaxMs = Math.round(loop.max / 1e5) / 10;
  results.eventLoopDelayP99Ms = Math.round(loop.percentile(99) / 1e5) / 10;
  results.keybindingConflicts = await keybindingConflicts();

  if (process.env.SEARCHIE_SMOKE_OUT) fs.writeFileSync(process.env.SEARCHIE_SMOKE_OUT, JSON.stringify(results, null, 2));
}
