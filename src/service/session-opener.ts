import * as vscode from 'vscode';
import { EMPTY_WINDOW, SOURCE_LABELS } from '../core/ids';
import type { SessionListItem } from '../store/index-db';
import type { PreviewHost, PreviewManager } from '../ui/preview-panel';
import { UNTITLED } from '../ui/format';
import { ChatOpener } from './chat-opener';
import { uiSettings } from './config';
import { consumePendingOpen, PENDING_FILE, writePendingOpen } from './pending-open';
import type { SearchieService } from './searchie-service';
import type { PreviewOptions, SessionActions } from './session-actions';

/** The §8 flow: Open in Chat, other-workspace choice, empty window, Insiders↔Stable, pending-open (R8.1–R8.7). */

const isEmptyWindowSession = (s: SessionListItem): boolean => s.workspaceId.endsWith(`:${EMPTY_WINDOW}`);

export class SessionOpener implements SessionActions, PreviewHost, vscode.Disposable {
  private readonly chat: ChatOpener;
  private previews: PreviewManager | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly service: SearchieService) {
    this.chat = new ChatOpener(service.window, service.log);
  }

  attachPreviews(previews: PreviewManager): void {
    this.previews = previews;
  }

  /** The session can be opened in this window's Chat: same source, and its file is in this window's chat storage. */
  isLocal(s: SessionListItem): boolean {
    return s.source === this.service.window.source && this.chat.hasLocalSession(s.id);
  }

  private newWindowLabel(s: SessionListItem): string {
    return isEmptyWindowSession(s) ? 'Open in New Empty Window' : 'Open Workspace in New Window';
  }

  openActions(s: SessionListItem): Promise<{ canOpenInChat: boolean; canOpenNewWindow: boolean; openInChatLabel: string; newWindowLabel: string }> {
    const local = this.isLocal(s);
    const sameApp = s.source === this.service.window.source;
    return Promise.resolve({
      canOpenInChat: local,
      canOpenNewWindow: sameApp && !local && (isEmptyWindowSession(s) || s.workspaceUri !== undefined),
      openInChatLabel: 'Open in Chat',
      newWindowLabel: this.newWindowLabel(s),
    });
  }

  preview(s: SessionListItem, options?: PreviewOptions): Promise<void> {
    return this.previews?.show(s, options) ?? Promise.resolve();
  }

  async openInChat(s: SessionListItem): Promise<void> {
    if ((await this.chat.open(s.id, uiSettings().chatLocation)) === 'opened') return;
    await this.preview(s);
    const pick = await vscode.window.showInformationMessage(
      'Searchie could not open this session in Copilot Chat; it is shown as a read-only preview.',
      'Pick in Chat history',
    );
    if (pick) await this.chat.pickInChatHistory(s.title || UNTITLED);
  }

  async open(s: SessionListItem): Promise<void> {
    if (this.isLocal(s)) {
      await this.openInChat(s);
      return;
    }
    if (s.source !== this.service.window.source) {
      // R8.6 – sessions of the other VS Code app (Insiders ↔ Stable) open as a preview only.
      await this.preview(s);
      void vscode.window.showInformationMessage(`This session belongs to ${SOURCE_LABELS[s.source] ?? s.source}. It is shown as a read-only preview.`);
      return;
    }
    const choice = uiSettings().otherWorkspaceDefault;
    if (choice === 'preview') return this.preview(s);
    if (choice === 'newWindow') return this.openWorkspaceInNewWindow(s);
    const previewLabel = 'Open Read-only Preview';
    const windowLabel = this.newWindowLabel(s);
    const where = isEmptyWindowSession(s) ? 'an empty window' : `the workspace "${s.workspaceName}"`;
    const pick = await vscode.window.showInformationMessage(
      `This session belongs to ${where}.`,
      { modal: true, detail: 'Copilot Chat can only open sessions of the current window. Preview it here, or open its workspace in a new window and continue the chat there.' },
      previewLabel,
      windowLabel,
    );
    if (pick === previewLabel) await this.preview(s);
    else if (pick === windowLabel) await this.openWorkspaceInNewWindow(s);
  }

  /** R8.4, R8.7 – write the pending-open request, then open the workspace (or an empty window) in a new window. */
  async openWorkspaceInNewWindow(s: SessionListItem): Promise<void> {
    if (s.source !== this.service.window.source) {
      await this.preview(s);
      void vscode.window.showInformationMessage(`This session belongs to ${SOURCE_LABELS[s.source] ?? s.source}; open it there. Here it is shown as a read-only preview.`);
      return;
    }
    if (this.isLocal(s)) {
      await this.openInChat(s);
      return;
    }
    const meta = await this.service.sessionMeta(s.key);
    const emptyWindow = isEmptyWindowSession(s);
    const workspaceIds = meta ? [meta.workspaceId, ...meta.copies.map((c) => c.workspaceId)] : [s.workspaceId];
    if (!emptyWindow && !s.workspaceUri) {
      void vscode.window.showWarningMessage('Searchie: the location of this workspace is unknown. Showing a read-only preview instead.');
      await this.preview(s);
      return;
    }
    writePendingOpen(this.service.dir, { sessionId: s.id, source: s.source, workspaceIds: emptyWindow ? [] : workspaceIds, emptyWindow });
    this.service.log.info(`pending open written for ${s.id}`);
    if (emptyWindow) await vscode.commands.executeCommand('workbench.action.newWindow');
    else await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.parse(s.workspaceUri!), { forceNewWindow: true });
  }

  /** R8.7 – consume a request at startup and whenever the request file changes (already-open target window). */
  startPendingOpenListener(): void {
    const consume = (startup: boolean): void => {
      const w = this.service.window;
      const req = consumePendingOpen(this.service.dir, { source: w.source, workspaceId: w.workspaceId, isEmptyWindow: w.isEmptyWindow, startup });
      if (!req) return;
      this.service.log.info(`pending open consumed for ${req.sessionId}`);
      void this.openPending(req.sessionId);
    };
    consume(true);
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(this.service.dir), PENDING_FILE));
    this.disposables.push(watcher, watcher.onDidCreate(() => consume(false)), watcher.onDidChange(() => consume(false)));
  }

  private async openPending(sessionId: string): Promise<void> {
    // The chat storage of a freshly opened window is on disk already; retry briefly in case the watcher fired early.
    for (let i = 0; i < 10 && !this.chat.hasLocalSession(sessionId); i++) await new Promise((r) => setTimeout(r, 300));
    if ((await this.chat.open(sessionId, uiSettings().chatLocation)) === 'opened') return;
    const s = (await this.service.listSessions({})).find((x) => x.id === sessionId && x.source === this.service.window.source);
    if (s) await this.openInChat(s);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
