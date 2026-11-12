import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { SearchSort } from '../query/engine';
import type { SessionListItem } from '../store/index-db';
import type { SearchieService } from '../service/searchie-service';
import type { SessionActions } from '../service/session-actions';
import { RpcCancelledError } from '../service/worker-client';
import { type SearchHostToWebview, SearchWebviewToHostSchema } from '../webview/search-protocol';
import { HISTORY_KEY, pushHistory, type SearchPanelOptions, toPanelResults } from './panel-model';
import type { QuickPickScope } from './quick-pick';

/** Search Panel (§7.3, R7.11–R7.19): a webview editor tab; the host runs queries and owns every session action. */

const nonce = (): string => randomBytes(16).toString('base64');

export class SearchPanel implements vscode.Disposable {
  private static current: SearchPanel | undefined;

  private scope: QuickPickScope | undefined;
  private pendingQuery: string | undefined;
  /** Sessions sent to the webview; actions only accept keys from here (the webview is never trusted). */
  private readonly sessions = new Map<string, SessionListItem>();
  private terms: string[] = [];
  private cts: vscode.CancellationTokenSource | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  static show(context: vscode.ExtensionContext, service: SearchieService, actions: SessionActions, options: SearchPanelOptions = {}): void {
    const existing = SearchPanel.current;
    if (existing) {
      existing.panel.reveal();
      if (options.query !== undefined || options.scope) existing.apply(options);
      return;
    }
    const panel = vscode.window.createWebviewPanel('searchie.searchPanel', 'Searchie', vscode.ViewColumn.Active, {
      enableScripts: true,
      enableFindWidget: false,
      retainContextWhenHidden: false,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')],
    });
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'searchie.svg');
    SearchPanel.current = new SearchPanel(panel, context, service, actions, options);
  }

  private constructor(
    readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly service: SearchieService,
    private readonly actions: SessionActions,
    options: SearchPanelOptions,
  ) {
    this.scope = options.scope;
    this.pendingQuery = options.query;
    panel.webview.html = this.html();
    this.disposables.push(
      panel.webview.onDidReceiveMessage((m: unknown) => void this.onMessage(m)),
      panel.onDidDispose(() => this.dispose()),
    );
  }

  private apply(options: SearchPanelOptions): void {
    this.scope = options.scope;
    this.pendingQuery = options.query ?? '';
    void this.sendInit();
  }

  private html(): string {
    const w = this.panel.webview;
    const n = nonce();
    const base = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview');
    const js = w.asWebviewUri(vscode.Uri.joinPath(base, 'search.js'));
    const css = w.asWebviewUri(vscode.Uri.joinPath(base, 'search.css'));
    const csp = `default-src 'none'; img-src ${w.cspSource} data:; style-src ${w.cspSource}; font-src ${w.cspSource}; script-src 'nonce-${n}';`;
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width, initial-scale=1.0"><link rel="stylesheet" href="${css.toString()}"><title>Searchie</title></head><body><div id="app"></div><script nonce="${n}" src="${js.toString()}"></script></body></html>`;
  }

  private post(m: SearchHostToWebview): void {
    void this.panel.webview.postMessage(m);
  }

  private get history(): string[] {
    const h = this.context.globalState.get<unknown>(HISTORY_KEY);
    return Array.isArray(h) ? h.filter((x): x is string => typeof x === 'string') : [];
  }

  private async sendInit(): Promise<void> {
    let facets = { sources: [] as string[], workspaces: [] as string[], models: [] as string[], modes: [] as string[] };
    try {
      facets = await this.service.facets();
    } catch {
      // index not ready: empty dropdowns, the query box still works
    }
    const query = this.pendingQuery;
    this.pendingQuery = undefined;
    this.post({ type: 'init', facets, history: this.history, query, scope: this.scope && { label: this.scope.label } });
  }

  private async onMessage(raw: unknown): Promise<void> {
    const parsed = SearchWebviewToHostSchema.safeParse(raw);
    if (!parsed.success) {
      this.service.log.warn('ignored an invalid message from the search panel');
      return;
    }
    const m = parsed.data;
    switch (m.type) {
      case 'ready':
        await this.sendInit();
        return;
      case 'search':
        await this.search(m.requestId, m.query, m.sort, m.offset);
        return;
      case 'commit': {
        const history = pushHistory(this.history, m.query);
        await this.context.globalState.update(HISTORY_KEY, history);
        this.post({ type: 'history', history });
        return;
      }
      case 'clearScope':
        this.scope = undefined;
        return;
      case 'action': {
        const s = this.sessions.get(m.key);
        if (!s) return;
        if (m.action === 'open') await this.actions.open(s);
        else if (m.action === 'preview') await this.actions.preview(s, { terms: this.terms, turnIndex: m.turnIndex });
        else if (m.action === 'newWindow') await this.actions.openWorkspaceInNewWindow(s);
        else await this.actions.copyResumeCommand(s);
        return;
      }
    }
  }

  /** R6.12 – a newer query cancels the one in flight; the webview also ignores stale request ids. */
  private async search(requestId: number, query: string, sort: SearchSort, offset: number): Promise<void> {
    this.cts?.cancel();
    this.cts?.dispose();
    const cts = new vscode.CancellationTokenSource();
    this.cts = cts;
    const scope = this.scope && { sessionKey: this.scope.sessionKey, workspaceId: this.scope.workspaceId, folder: this.scope.folder };
    try {
      const r = await this.service.search({ query, sort, offset, scope }, cts.token);
      if (cts.token.isCancellationRequested) return;
      if (offset === 0) this.sessions.clear();
      for (const x of r.results) this.sessions.set(x.session.key, x.session);
      this.terms = r.terms;
      this.post(toPanelResults(requestId, r));
    } catch (e) {
      if (e instanceof RpcCancelledError) return;
      this.service.log.warn(`panel search failed (${(e as Error).name})`);
      this.post({ type: 'error', requestId, message: 'Search failed. See Searchie: Show Log.' });
    }
  }

  dispose(): void {
    if (SearchPanel.current === this) SearchPanel.current = undefined;
    this.cts?.cancel();
    this.cts?.dispose();
    for (const d of this.disposables) d.dispose();
    this.panel.dispose();
  }
}
