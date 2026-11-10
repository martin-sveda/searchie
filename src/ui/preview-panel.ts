import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { SessionListItem } from '../store/index-db';
import { uiSettings } from '../service/config';
import type { SearchieService } from '../service/searchie-service';
import type { PreviewOptions } from '../service/session-actions';
import { type HostToWebview, type PreviewData, WebviewToHostSchema } from '../webview/protocol';
import type { LoadedSession } from '../worker/protocol';
import { buildPreviewData, isFile } from './preview-data';
import { UNTITLED } from './format';

/** Read-only session Preview (R7.21–R7.25) as a webview editor tab. */

export interface PreviewHost {
  /** Label and availability of the primary action (§8): Open in Chat, or the other-workspace variant. */
  openActions(session: SessionListItem): Promise<{ canOpenInChat: boolean; openInChatLabel: string; newWindowLabel: string }>;
  openInChat(session: SessionListItem): Promise<void>;
  openWorkspaceInNewWindow(session: SessionListItem): Promise<void>;
}

const nonce = (): string => randomBytes(16).toString('base64');

class PreviewPanel {
  private loaded: LoadedSession | undefined;
  private data: PreviewData | undefined;
  private redacted = uiSettings().redactSecrets;
  private pendingReveal: PreviewOptions;

  constructor(
    readonly panel: vscode.WebviewPanel,
    private session: SessionListItem,
    private readonly service: SearchieService,
    private readonly host: PreviewHost,
    private readonly extensionUri: vscode.Uri,
    options: PreviewOptions,
  ) {
    this.pendingReveal = options;
    panel.webview.html = this.html();
    panel.webview.onDidReceiveMessage((m: unknown) => void this.onMessage(m));
  }

  private html(): string {
    const w = this.panel.webview;
    const n = nonce();
    const js = w.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'preview.js'));
    const css = w.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'preview.css'));
    const csp = `default-src 'none'; img-src ${w.cspSource} data:; style-src ${w.cspSource}; font-src ${w.cspSource}; script-src 'nonce-${n}';`;
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width, initial-scale=1.0"><link rel="stylesheet" href="${css.toString()}"><title>Searchie</title></head><body><div id="app"></div><script nonce="${n}" src="${js.toString()}"></script></body></html>`;
  }

  private post(m: HostToWebview): void {
    void this.panel.webview.postMessage(m);
  }

  reveal(session: SessionListItem, options: PreviewOptions): void {
    this.session = session;
    this.panel.reveal();
    if (this.data) this.post({ type: 'reveal', terms: options.terms ?? [], scrollTo: options.turnIndex });
    else this.pendingReveal = options;
  }

  private async sendInit(): Promise<void> {
    try {
      this.loaded ??= (await this.service.loadSession(this.session.key)) ?? undefined;
      if (!this.loaded) {
        this.post({ type: 'error', message: 'This session is no longer available. Run Searchie: Refresh Index.' });
        return;
      }
      this.data = await buildPreviewData(this.loaded, this.redacted);
      this.panel.title = `Searchie: ${this.data.title}`;
      const actions = await this.host.openActions(this.session);
      this.post({ type: 'init', data: this.data, terms: this.pendingReveal.terms ?? [], scrollTo: this.pendingReveal.turnIndex, redacted: this.redacted, ...actions });
    } catch (e) {
      this.service.log.warn(`preview failed for ${this.session.id} (${(e as Error).name})`);
      this.post({ type: 'error', message: 'The session could not be loaded. See Searchie: Show Log.' });
    }
  }

  private async onMessage(raw: unknown): Promise<void> {
    const parsed = WebviewToHostSchema.safeParse(raw);
    if (!parsed.success) {
      this.service.log.warn('ignored an invalid message from the preview webview');
      return;
    }
    const m = parsed.data;
    switch (m.type) {
      case 'ready':
        await this.sendInit();
        return;
      case 'setRedacted':
        this.redacted = m.redacted;
        this.pendingReveal = {};
        await this.sendInit();
        return;
      case 'openFile': {
        const f = this.data?.files[m.file];
        if (f && (await isFile(f.path))) await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(f.path));
        else void vscode.window.showInformationMessage('Searchie: this file does not exist on this machine.');
        return;
      }
      case 'openLink':
        await this.openLink(m.href);
        return;
      case 'openInChat':
        await this.host.openInChat(this.session);
        return;
      case 'openNewWindow':
        await this.host.openWorkspaceInNewWindow(this.session);
        return;
      case 'copySessionId':
        await vscode.env.clipboard.writeText(this.session.id);
        return;
    }
  }

  /** Links from chat markdown: local files only after an existence check (R10.8); http(s) via VS Code's external opener. */
  private async openLink(href: string): Promise<void> {
    let uri: vscode.Uri;
    try {
      uri = vscode.Uri.parse(href, true);
    } catch {
      return;
    }
    if (uri.scheme === 'file') {
      if (await isFile(uri.fsPath)) await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(uri.fsPath));
      else void vscode.window.showInformationMessage('Searchie: this file does not exist on this machine.');
    } else if (uri.scheme === 'http' || uri.scheme === 'https') {
      await vscode.env.openExternal(uri);
    }
  }
}

export class PreviewManager implements vscode.Disposable {
  private readonly panels = new Map<string, PreviewPanel>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly service: SearchieService,
    private readonly host: PreviewHost,
  ) {}

  show(session: SessionListItem, options: PreviewOptions = {}): Promise<void> {
    const existing = this.panels.get(session.key);
    if (existing) {
      existing.reveal(session, options);
      return Promise.resolve();
    }
    const panel = vscode.window.createWebviewPanel('searchie.preview', `Searchie: ${session.title || UNTITLED}`, vscode.ViewColumn.Active, {
      enableScripts: true,
      enableFindWidget: true,
      retainContextWhenHidden: false,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview')],
    });
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'searchie.svg');
    this.panels.set(session.key, new PreviewPanel(panel, session, this.service, this.host, this.context.extensionUri, options));
    panel.onDidDispose(() => this.panels.delete(session.key));
    return Promise.resolve();
  }

  dispose(): void {
    for (const p of this.panels.values()) p.panel.dispose();
    this.panels.clear();
  }
}
