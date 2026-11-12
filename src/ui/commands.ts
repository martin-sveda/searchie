import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { SOURCE_LABELS, type SourceId } from '../core/ids';
import type { SessionListItem } from '../store/index-db';
import type { SearchieService } from '../service/searchie-service';
import type { SessionActions } from '../service/session-actions';
import { panelOptions } from './panel-model';
import { currentScope, defaultScope, showSearchQuickPick } from './quick-pick';
import { SearchPanel } from './search-panel';
import { normalizeFilter } from '../query/stats';
import { uiSettings } from '../service/config';
import { STATS_TABLES, type StatsTable } from '../webview/stats-protocol';
import { csvFileName, statsCsv } from './csv';
import { StatsPanel } from './stats-panel';
import { isSessionNode, type SessionsTreeProvider, type TreeNode } from './tree';
import { type GroupBy, SORT_LABELS, type SortBy, type TreeFilter } from './tree-model';
import { UNTITLED } from './format';

/** Command handlers (§12.2, Phase 1). */

export interface CommandContext {
  context: vscode.ExtensionContext;
  service: SearchieService;
  tree: SessionsTreeProvider;
  view: vscode.TreeView<TreeNode>;
  actions: SessionActions;
}

function isListItem(v: unknown): v is SessionListItem {
  return typeof v === 'object' && v !== null && typeof (v as SessionListItem).key === 'string' && typeof (v as SessionListItem).workspaceId === 'string';
}

/** Session from a tree node, a list item, the tree selection, or (from the palette) a Quick Pick. */
async function resolveSession(c: CommandContext, arg: unknown): Promise<SessionListItem | undefined> {
  if (isSessionNode(arg)) return arg.session;
  if (isListItem(arg)) return arg;
  const selected = c.view.selection.find(isSessionNode);
  if (selected) return selected.session;
  const recent = await c.service.listSessions({});
  const pick = await vscode.window.showQuickPick(
    recent.slice(0, 200).map((s) => ({ label: s.title || UNTITLED, description: s.workspaceName, session: s })),
    { placeHolder: 'Select a session', matchOnDescription: true },
  );
  return pick?.session;
}

export function registerCommands(c: CommandContext): vscode.Disposable[] {
  const { service, tree, actions, context } = c;
  const state = context.globalState;
  const withSession = (fn: (s: SessionListItem) => Promise<unknown>) => async (arg?: unknown) => {
    const s = await resolveSession(c, arg);
    if (s) await fn(s);
  };
  const reg = (id: string, fn: (...args: unknown[]) => unknown): vscode.Disposable => vscode.commands.registerCommand(id, fn);

  return [
    reg('searchie.search', (arg?: unknown) => {
      const query = typeof (arg as { query?: unknown } | undefined)?.query === 'string' ? (arg as { query: string }).query : undefined;
      return showSearchQuickPick(service, actions, state, { query, scope: defaultScope(service) });
    }),
    reg('searchie.searchInWorkspace', (arg?: unknown) => {
      // R7.27 – a folder group scopes to every workspace with its folder key.
      if (isSessionNode(arg)) {
        const s = arg.session;
        const scope = s.folder !== undefined ? { label: s.workspaceName, folder: s.folder } : { label: s.workspaceName, workspaceId: s.workspaceId };
        return showSearchQuickPick(service, actions, state, { query: '', scope });
      }
      const node = arg as TreeNode | undefined;
      if (node?.kind === 'workspace') {
        const g = node.group;
        const scope = g.folder !== undefined ? { label: g.label, folder: g.folder } : { label: g.label, workspaceId: g.workspaceIds[0]! };
        return showSearchQuickPick(service, actions, state, { query: '', scope });
      }
      return showSearchQuickPick(service, actions, state, { scope: currentScope(service) });
    }),
    reg(
      'searchie.searchInSession',
      withSession((s) => showSearchQuickPick(service, actions, state, { query: '', scope: { label: s.title || UNTITLED, sessionKey: s.key } })),
    ),
    reg('searchie.openSearchPanel', (arg?: unknown) => SearchPanel.show(context, service, actions, panelOptions(arg))),
    reg('searchie.showStatistics', () => StatsPanel.show(context, service, actions)),
    reg('searchie.exportCsv', (arg?: unknown) => exportCsv(service, arg)),
    reg('searchie.filterSessions', () => filterSessions(c)),
    reg('searchie.openInChat', withSession((s) => actions.open(s))),
    reg('searchie.preview', withSession((s) => actions.preview(s))),
    reg('searchie.openWorkspaceInNewWindow', withSession((s) => actions.openWorkspaceInNewWindow(s))),
    reg('searchie.copyResumeCommand', withSession((s) => actions.copyResumeCommand(s))),
    reg(
      'searchie.copySessionId',
      withSession(async (s) => {
        await vscode.env.clipboard.writeText(s.id);
        service.log.info(`copied session id ${s.id}`);
      }),
    ),
    reg(
      'searchie.revealSessionFile',
      withSession(async (s) => {
        const meta = await service.sessionMeta(s.key);
        if (!meta) return;
        try {
          await fs.promises.stat(meta.filePath);
        } catch {
          void vscode.window.showWarningMessage('Searchie: the session file no longer exists. Run Searchie: Refresh Index.');
          return;
        }
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(meta.filePath));
      }),
    ),
    reg('searchie.refresh', async () => {
      await service.sync('manual', { throttle: false });
      tree.refresh();
    }),
    reg('searchie.rebuildIndex', () => service.rebuild()),
    reg('searchie.deleteIndex', async () => {
      const ok = await vscode.window.showWarningMessage(
        'Delete the Searchie index? It contains a copy of your Copilot chat content. Your chat sessions themselves are not touched.',
        { modal: true },
        'Delete Index',
      );
      if (ok === 'Delete Index') await service.deleteIndex();
    }),
    reg('searchie.showLog', () => service.log.show()),
  ];
}

/**
 * R9.3 – re-runs the statistics with the given filter in the worker (rows from the webview are never written) and
 * writes only the file the user picks in the save dialog.
 */
async function exportCsv(service: SearchieService, arg: unknown): Promise<void> {
  const o = typeof arg === 'object' && arg !== null ? (arg as Record<string, unknown>) : {};
  const table = (STATS_TABLES as readonly unknown[]).includes(o.table) ? (o.table as StatsTable) : undefined;
  if (!table) return;
  const result = await service.statistics(normalizeFilter(o.filter));
  if (!result) {
    void vscode.window.showWarningMessage('Searchie: the index is not ready yet. Try again when indexing has finished.');
    return;
  }
  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(os.homedir(), csvFileName(table))),
    filters: { CSV: ['csv'] },
    saveLabel: 'Export',
    title: 'Export statistics table as CSV',
  });
  if (!uri) return;
  const { text, rows } = statsCsv(result, table, uiSettings().redactSecrets);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
  service.log.info(`exported statistics table ${table} (${rows} rows)`);
  void vscode.window.setStatusBarMessage(`Searchie: exported ${rows} rows`, 3000);
}

interface FilterPick extends vscode.QuickPickItem {
  id: 'source' | 'model' | 'mode' | 'date' | 'group' | 'sort' | 'clear';
}

/** R7.6 – Filter (source, model, mode, date range) plus Group by (R7.1) and Sort by (R7.2). */
async function filterSessions(c: CommandContext): Promise<void> {
  const { tree, service } = c;
  const f = tree.filter;
  const list = (v: string[] | undefined): string => (v?.length ? v.join(', ') : 'all');
  const groupBy = vscode.workspace.getConfiguration('searchie').get<GroupBy>('tree.groupBy', 'workspaceDate');
  const top = await vscode.window.showQuickPick<FilterPick>(
    [
      { id: 'source', label: '$(filter) Source…', description: list(f.sources?.map((s) => SOURCE_LABELS[s as SourceId] ?? s)) },
      { id: 'model', label: '$(filter) Model…', description: list(f.models) },
      { id: 'mode', label: '$(filter) Mode…', description: list(f.modes) },
      { id: 'date', label: '$(calendar) Date range…', description: f.days ? `last ${f.days} days` : 'any time' },
      { id: 'group', label: '$(list-tree) Group by…', description: groupBy },
      { id: 'sort', label: '$(sort-precedence) Sort by…', description: SORT_LABELS[tree.sort] },
      { id: 'clear', label: '$(clear-all) Clear filters' },
    ],
    { placeHolder: 'Filter or arrange the Sessions view' },
  );
  if (!top) return;
  const facets = await service.facets();
  const multi = async (values: string[], selected: string[] | undefined, label: (v: string) => string = (v) => v): Promise<string[] | undefined> => {
    const picks = await vscode.window.showQuickPick(
      values.map((v) => ({ label: label(v), value: v, picked: selected?.includes(v) ?? false })),
      { canPickMany: true, placeHolder: 'Select values (none = all)' },
    );
    return picks?.map((p) => p.value);
  };
  let next: TreeFilter | undefined;
  switch (top.id) {
    case 'source': {
      const v = await multi(facets.sources, f.sources, (s) => SOURCE_LABELS[s as SourceId] ?? s);
      if (v) next = { ...f, sources: v };
      break;
    }
    case 'model': {
      const v = await multi(facets.models, f.models);
      if (v) next = { ...f, models: v };
      break;
    }
    case 'mode': {
      const v = await multi(facets.modes, f.modes);
      if (v) next = { ...f, modes: v };
      break;
    }
    case 'date': {
      const pick = await vscode.window.showQuickPick(
        [
          { label: 'Any time', days: undefined },
          { label: 'Last 7 days', days: 7 },
          { label: 'Last 30 days', days: 30 },
          { label: 'Last 90 days', days: 90 },
          { label: 'Last 365 days', days: 365 },
        ],
        { placeHolder: 'Show sessions active in…' },
      );
      if (pick) next = { ...f, days: pick.days };
      break;
    }
    case 'group': {
      const pick = await vscode.window.showQuickPick(
        [
          { label: 'Workspace → Date', value: 'workspaceDate' },
          { label: 'Date → Workspace', value: 'dateWorkspace' },
          { label: 'Flat', value: 'flat' },
        ],
        { placeHolder: 'Group sessions by…' },
      );
      if (pick) await vscode.workspace.getConfiguration('searchie').update('tree.groupBy', pick.value, vscode.ConfigurationTarget.Global);
      tree.refresh();
      return;
    }
    case 'sort': {
      const pick = await vscode.window.showQuickPick(
        (Object.keys(SORT_LABELS) as SortBy[]).map((k) => ({ label: SORT_LABELS[k], value: k })),
        { placeHolder: 'Sort sessions by…' },
      );
      if (pick) await tree.setSort(pick.value);
      return;
    }
    case 'clear':
      next = {};
      break;
  }
  if (next) await tree.setFilter(next);
}
