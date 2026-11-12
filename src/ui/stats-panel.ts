import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { normalizeFilter, type StatsResult } from '../query/stats';
import { uiSettings } from '../service/config';
import type { SearchieService } from '../service/searchie-service';
import type { SessionActions } from '../service/session-actions';
import { RpcCancelledError } from '../service/worker-client';
import { type StatsFilterMessage, type StatsHostToWebview, StatsWebviewToHostSchema } from '../webview/stats-protocol';
import { SearchPanel } from './search-panel';
import { redactStats, toolQuery } from './stats-model';

/** Statistics view (§7.5, §9): a webview editor tab; the worker's StatsEngine computes every widget in one RPC. */

const nonce = (): string => randomBytes(16).toString('base64');

export class StatsPanel implements vscode.Disposable {
  private static current: StatsPanel | undefined;
  /** N5 – command → all widgets rendered, of the most recent open (smoke test, log). */
  static lastRenderMs: number | undefined;

  private openedAt: number;
  private firstRequest: number | undefined;
  /** Session keys of the last result; openSession only accepts these (the webview is never trusted). */
  private sessionKeys = new Set<string>();
  private cts: vscode.CancellationTokenSource | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  static show(context: vscode.ExtensionContext, service: SearchieService, actions: SessionActions): void {
    const openedAt = performance.now();
    if (StatsPanel.current) {
      StatsPanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel('searchie.statistics', 'Searchie Statistics', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: false,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')],
    });
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'searchie.svg');
    StatsPanel.current = new StatsPanel(panel, context, service, actions, openedAt);
  }

  private constructor(
    readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly service: SearchieService,
    private readonly actions: SessionActions,
    openedAt: number,
  ) {
    this.openedAt = openedAt;
    panel.webview.html = this.html();
    this.disposables.push(
      panel.webview.onDidReceiveMessage((m: unknown) => void this.onMessage(m)),
      panel.onDidDispose(() => this.dispose()),
      // A re-shown tab reloads the webview (retainContextWhenHidden = false); time that load too.
      panel.onDidChangeViewState((e) => {
        if (e.webviewPanel.visible) this.openedAt = performance.now();
      }),
    );
  }

  private html(): string {
    const w = this.panel.webview;
    const n = nonce();
    const base = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview');
    const js = w.asWebviewUri(vscode.Uri.joinPath(base, 'stats.js'));
    const css = w.asWebviewUri(vscode.Uri.joinPath(base, 'stats.css'));
    // Chart.js sizes canvases through the CSSOM (element.style), which this CSP allows; no inline style attributes.
    const csp = `default-src 'none'; img-src ${w.cspSource} data:; style-src ${w.cspSource}; font-src ${w.cspSource}; script-src 'nonce-${n}';`;
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width, initial-scale=1.0"><link rel="stylesheet" href="${css.toString()}"><title>Searchie Statistics</title></head><body><div id="app"></div><script nonce="${n}" src="${js.toString()}"></script></body></html>`;
  }

  private post(m: StatsHostToWebview): void {
    void this.panel.webview.postMessage(m);
  }

  private async onMessage(raw: unknown): Promise<void> {
    const parsed = StatsWebviewToHostSchema.safeParse(raw);
    if (!parsed.success) {
      this.service.log.warn('ignored an invalid message from the statistics view');
      return;
    }
    const m = parsed.data;
    switch (m.type) {
      case 'ready':
        this.firstRequest = undefined;
        this.post({ type: 'init' });
        return;
      case 'query':
        this.firstRequest ??= m.requestId;
        await this.query(m.requestId, m.filter);
        return;
      case 'rendered':
        if (m.requestId === this.firstRequest) {
          StatsPanel.lastRenderMs = performance.now() - this.openedAt;
          this.service.log.info(`statistics rendered in ${StatsPanel.lastRenderMs.toFixed(0)} ms`);
        }
        return;
      case 'searchTool':
        SearchPanel.show(this.context, this.service, this.actions, { query: toolQuery(m.tool) });
        return;
      case 'openSession': {
        if (!this.sessionKeys.has(m.key)) return;
        const [s] = await this.service.listSessions({ keys: [m.key] });
        if (s) await this.actions.preview(s);
        return;
      }
      case 'export':
        await vscode.commands.executeCommand('searchie.exportCsv', { table: m.table, filter: m.filter });
        return;
    }
  }

  /** R9.1 – one worker call per filter change; a newer filter cancels the one in flight. */
  private async query(requestId: number, filter: StatsFilterMessage): Promise<void> {
    this.cts?.cancel();
    this.cts?.dispose();
    const cts = new vscode.CancellationTokenSource();
    this.cts = cts;
    try {
      const result: StatsResult | null = await this.service.statistics(normalizeFilter(filter), cts.token);
      if (cts.token.isCancellationRequested) return;
      if (!result) {
        this.post({ type: 'error', requestId, message: 'The index is not ready yet. Try again when indexing has finished.' });
        return;
      }
      const shown = redactStats(result, uiSettings().redactSecrets);
      this.sessionKeys = new Set([...shown.top.byPrompts, ...shown.top.byCredits, ...shown.top.byDuration].map((s) => s.key));
      this.post({ type: 'data', requestId, result: shown });
    } catch (e) {
      if (e instanceof RpcCancelledError) return;
      this.service.log.warn(`statistics failed (${(e as Error).name})`);
      this.post({ type: 'error', requestId, message: 'Statistics failed. See Searchie: Show Log.' });
    }
  }

  dispose(): void {
    if (StatsPanel.current === this) StatsPanel.current = undefined;
    this.cts?.cancel();
    this.cts?.dispose();
    for (const d of this.disposables) d.dispose();
    this.panel.dispose();
  }
}
