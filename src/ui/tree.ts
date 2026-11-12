import * as vscode from 'vscode';
import { SOURCE_LABELS } from '../core/ids';
import type { IndexSummary, SessionListItem } from '../store/index-db';
import { uiSettings } from '../service/config';
import type { IndexStatus, SearchieService } from '../service/searchie-service';
import { escapeMarkdown, formatBytes, formatCount, formatDateTime, formatDuration, plural, relativeTime, shortModel, UNTITLED } from './format';
import { compareSessions, type DateBucket, filterSummary, groupByDate, groupByWorkspace, type SortBy, type TreeFilter, type WorkspaceGroup } from './tree-model';

/** Sessions view (R7.1–R7.7). */

export type TreeNode =
  | { kind: 'status'; status: IndexStatus }
  | { kind: 'summary'; summary: IndexSummary }
  | { kind: 'workspace'; group: WorkspaceGroup }
  | { kind: 'date'; bucket: DateBucket; sessions: SessionListItem[]; parent?: string; expanded: boolean }
  | { kind: 'session'; session: SessionListItem };

export const FILTER_KEY = 'searchie.tree.filter';
export const SORT_KEY = 'searchie.tree.sort';

export function isSessionNode(v: unknown): v is Extract<TreeNode, { kind: 'session' }> {
  return typeof v === 'object' && v !== null && (v as { kind?: unknown }).kind === 'session';
}

export class SessionsTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private sessions: SessionListItem[] | undefined;
  private summary: IndexSummary | undefined;
  private loading: Promise<void> | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  view?: vscode.TreeView<TreeNode>;

  constructor(
    private readonly service: SearchieService,
    private readonly state: vscode.Memento,
  ) {
    this.disposables.push(
      this.emitter,
      service.onDidChangeIndex(() => this.refresh()),
      service.onDidChangeStatus(() => this.emitter.fire(undefined)),
    );
  }

  get filter(): TreeFilter {
    return this.state.get<TreeFilter>(FILTER_KEY) ?? {};
  }

  get sort(): SortBy {
    return this.state.get<SortBy>(SORT_KEY) ?? 'lastActivity';
  }

  async setFilter(filter: TreeFilter): Promise<void> {
    await this.state.update(FILTER_KEY, filter);
    this.refresh();
  }

  async setSort(sort: SortBy): Promise<void> {
    await this.state.update(SORT_KEY, sort);
    this.emitter.fire(undefined);
  }

  refresh(): void {
    this.sessions = undefined;
    this.summary = undefined;
    this.emitter.fire(undefined);
  }

  /** Loaded session rows (for commands that need the selection's data). */
  get loadedSessions(): readonly SessionListItem[] {
    return this.sessions ?? [];
  }

  private load(): Promise<void> {
    this.loading ??= (async () => {
      const f = this.filter;
      try {
        const [sessions, summary] = await Promise.all([
          this.service.listSessions({ sources: f.sources, models: f.models, modes: f.modes, after: f.days ? Date.now() - f.days * 86_400_000 : undefined }),
          this.service.summary(),
        ]);
        this.sessions = sessions;
        this.summary = summary;
      } catch (e) {
        this.service.log.warn(`loading sessions failed (${(e as Error).name})`);
        this.sessions = [];
      } finally {
        this.loading = undefined;
      }
      if (this.view) this.view.description = filterSummary(f);
    })();
    return this.loading;
  }

  async getChildren(node?: TreeNode): Promise<TreeNode[]> {
    if (!this.sessions) await this.load();
    const sessions = this.sessions ?? [];
    const sort = this.sort;
    if (!node) {
      const top: TreeNode[] = [];
      const st = this.service.currentStatus;
      if (st.state === 'indexing' || st.state === 'waiting' || st.state === 'deleted' || st.state === 'error' || st.failedFiles > 0) top.push({ kind: 'status', status: st });
      if (sessions.length === 0) return top.length && st.state !== 'idle' ? top : [];
      if (this.summary) top.push({ kind: 'summary', summary: this.summary });
      const groupBy = uiSettings().groupBy;
      if (groupBy === 'flat') return [...top, ...[...sessions].sort(compareSessions(sort)).map((s) => ({ kind: 'session' as const, session: s }))];
      if (groupBy === 'dateWorkspace') return [...top, ...groupByDate(sessions, sort).map((g, i) => ({ kind: 'date' as const, bucket: g.bucket, sessions: g.sessions, expanded: i === 0 }))];
      return [...top, ...groupByWorkspace(sessions, this.service.currentWorkspace(), sort).map((group) => ({ kind: 'workspace' as const, group }))];
    }
    if (node.kind === 'workspace') {
      return groupByDate(node.group.sessions, sort).map((g, i) => ({ kind: 'date', bucket: g.bucket, sessions: g.sessions, parent: node.group.id, expanded: node.group.current && i === 0 }));
    }
    if (node.kind === 'date') {
      if (node.parent || uiSettings().groupBy !== 'dateWorkspace') return node.sessions.map((s) => ({ kind: 'session', session: s }));
      return groupByWorkspace(node.sessions, this.service.currentWorkspace(), sort).map((group) => ({ kind: 'workspace', group: { ...group, id: `${node.bucket.id}/${group.id}` } }));
    }
    return [];
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    switch (node.kind) {
      case 'status':
        return statusItem(node.status);
      case 'summary':
        return summaryItem(node.summary);
      case 'workspace': {
        const item = new vscode.TreeItem(node.group.label, node.group.current ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `ws:${node.group.id}`;
        item.description = plural(node.group.sessions.length, 'session');
        item.iconPath = new vscode.ThemeIcon(node.group.id.endsWith(':empty-window') ? 'empty-window' : node.group.folder === undefined ? 'folder' : node.group.current ? 'root-folder-opened' : 'root-folder');
        item.contextValue = 'workspace';
        return item;
      }
      case 'date': {
        const item = new vscode.TreeItem(node.bucket.label, node.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `date:${node.parent ?? ''}/${node.bucket.id}`;
        item.description = plural(node.sessions.length, 'session');
        item.iconPath = new vscode.ThemeIcon('calendar');
        return item;
      }
      case 'session':
        return sessionItem(node.session);
    }
  }

  /** Tooltip with per-session statistics is loaded on hover (R7.3). */
  async resolveTreeItem(item: vscode.TreeItem, node: TreeNode, token: vscode.CancellationToken): Promise<vscode.TreeItem> {
    if (node.kind !== 'session') return item;
    const meta = await this.service.sessionMeta(node.session.key);
    if (!meta || token.isCancellationRequested) return item;
    const top = (o: Record<string, number>, n = 5): string =>
      Object.entries(o)
        .slice(0, n)
        .map(([k, v]) => `${escapeMarkdown(k)} (${v})`)
        .join(', ') || '—';
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = false;
    md.supportHtml = false;
    md.appendMarkdown(`**${escapeMarkdown(meta.title || UNTITLED)}**\n\n`);
    const rows: [string, string][] = [
      ['Workspace', escapeMarkdown(meta.workspaceName)],
      ['Source', SOURCE_LABELS[meta.source]],
      ['Created', formatDateTime(meta.createdAt)],
      ['Last activity', formatDateTime(meta.lastActivityAt)],
      ['Turns', formatCount(meta.turnCount)],
      ['Prompts', `${formatCount(meta.promptCount)} (${formatCount(meta.noisePromptCount)} noise)`],
      ['Canceled', formatCount(meta.canceledCount)],
      ['Tool calls', formatCount(meta.toolCallCount)],
      ['Top tools', top(meta.tools)],
      ['Models', top(meta.models, 3)],
      ['Modes', top(meta.modes, 3)],
      ['Tokens in / out', `${formatCount(meta.promptTokens)} / ${formatCount(meta.completionTokens)}`],
      ['Credits', formatCount(meta.credits)],
      ['Duration', formatDuration(meta.lastActivityAt - meta.createdAt)],
      ['Model time', formatDuration(meta.elapsedMs)],
      ['File size', formatBytes(meta.sizeBytes)],
    ];
    if (meta.copies.length) rows.push(['Also in', meta.copies.map((c) => escapeMarkdown(c.workspaceName)).join(', ')]);
    md.appendMarkdown(rows.map(([k, v]) => `${k}: ${v}`).join('  \n'));
    item.tooltip = md;
    return item;
  }

  getParent(): undefined {
    return undefined;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

export function sessionDescription(s: SessionListItem, now = Date.now()): string {
  return [plural(s.promptCount, 'prompt'), shortModel(s.primaryModel), s.primaryMode, relativeTime(s.lastActivityAt, now)].filter(Boolean).join(' · ');
}

function sessionItem(s: SessionListItem): vscode.TreeItem {
  const item = new vscode.TreeItem(s.title || UNTITLED, vscode.TreeItemCollapsibleState.None);
  item.id = `session:${s.key}`;
  item.description = sessionDescription(s);
  item.iconPath = new vscode.ThemeIcon(s.source === 'copilot-cli' ? 'terminal' : 'comment-discussion');
  item.contextValue = s.source === 'copilot-cli' ? 'session.cli' : 'session';
  item.command = { command: 'searchie.preview', title: 'Preview Session', arguments: [{ kind: 'session', session: s }] };
  item.accessibilityInformation = { label: `${s.title || UNTITLED}, ${item.description}` };
  return item;
}

function summaryItem(s: IndexSummary): vscode.TreeItem {
  const parts = [plural(s.sessions, 'session'), plural(s.prompts, 'prompt'), plural(s.workspaces, 'workspace')];
  if (s.credits30d !== null) parts.push(`${formatCount(s.credits30d, true)} credits (30d)`);
  const item = new vscode.TreeItem(`Summary: ${parts.join(' · ')}`, vscode.TreeItemCollapsibleState.None);
  item.id = 'summary';
  item.iconPath = new vscode.ThemeIcon('graph');
  item.tooltip = 'Sessions with at least one turn; credits as recorded in the last 30 days. Click to show statistics.';
  item.command = { command: 'searchie.showStatistics', title: 'Show Statistics' };
  return item;
}

function statusItem(st: IndexStatus): vscode.TreeItem {
  let label: string;
  let icon: string;
  let command: vscode.Command | undefined;
  if (st.state === 'indexing') {
    label = st.total ? `Indexing ${formatCount(st.done)}/${formatCount(st.total)}…` : 'Indexing…';
    icon = 'sync~spin';
  } else if (st.state === 'waiting') {
    label = 'Waiting for the index (built by another window)…';
    icon = 'loading~spin';
  } else if (st.state === 'deleted') {
    label = 'Index deleted – click to rebuild';
    icon = 'trash';
    command = { command: 'searchie.refresh', title: 'Refresh Index' };
  } else if (st.state === 'error') {
    label = 'Indexing error – show log';
    icon = 'error';
    command = { command: 'searchie.showLog', title: 'Show Log' };
  } else {
    label = `${plural(st.failedFiles, 'file')} could not be indexed – show log`;
    icon = 'warning';
    command = { command: 'searchie.showLog', title: 'Show Log' };
  }
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  item.id = 'status';
  item.iconPath = new vscode.ThemeIcon(icon);
  item.command = command;
  return item;
}
