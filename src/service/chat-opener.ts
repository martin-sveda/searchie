import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import type { CurrentWindow } from './searchie-service';

/**
 * Opens a VS Code chat session in Copilot Chat (R8.1, R8.2). Every mechanism here is internal VS Code surface,
 * so it is isolated, feature-detected, and pre-checked: the calls don't throw on failure (an error editor appears).
 */

export const CHAT_SESSION_SCHEME = 'vscode-chat-session';
export const OPEN_SESSION_COMMAND = 'workbench.action.chat.openSessionInEditorGroup';
/** "Move Chat into Side Bar": loads the active chat editor's session into the Chat view and closes the editor. */
export const MOVE_TO_VIEW_COMMAND = 'workbench.action.chat.openInSidebar';
const PICK_SESSION_COMMANDS = ['workbench.action.chat.pickAgentSession', 'workbench.action.chat.history'];

/** `LocalChatSessionUri.forSession`: base64url(utf8(sessionId)) without padding, authority `local`. */
export function localChatSessionUri(sessionId: string): vscode.Uri {
  return vscode.Uri.from({ scheme: CHAT_SESSION_SCHEME, authority: 'local', path: `/${Buffer.from(sessionId, 'utf8').toString('base64url')}` });
}

export type OpenResult = 'opened' | 'unavailable';

export class ChatOpener {
  private commands: Set<string> | undefined;

  constructor(
    private readonly window: CurrentWindow,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  private async available(): Promise<Set<string>> {
    this.commands ??= new Set(await vscode.commands.getCommands(true));
    return this.commands;
  }

  /** R8.1 pre-check: the session file exists in this window's own chat storage. */
  hasLocalSession(sessionId: string): boolean {
    if (!/^[\w.-]+$/.test(sessionId)) return false;
    return ['jsonl', 'json'].some((ext) => fs.existsSync(path.join(this.window.chatSessionsDir, `${sessionId}.${ext}`)));
  }

  async open(sessionId: string, location: 'view' | 'editor' = 'view'): Promise<OpenResult> {
    if (!this.hasLocalSession(sessionId)) return 'unavailable';
    const resource = localChatSessionUri(sessionId);
    let opened = false;
    try {
      await vscode.commands.executeCommand('vscode.open', resource);
      this.log.info(`opened ${sessionId} as chat editor (vscode.open)`);
      opened = true;
    } catch (e) {
      this.log.warn(`vscode.open failed for ${sessionId} (${(e as Error).name})`);
    }
    if (!opened && (await this.available()).has(OPEN_SESSION_COMMAND)) {
      try {
        await vscode.commands.executeCommand(OPEN_SESSION_COMMAND, { resource });
        this.log.info(`opened ${sessionId} as chat editor (${OPEN_SESSION_COMMAND})`);
        opened = true;
      } catch (e) {
        this.log.warn(`${OPEN_SESSION_COMMAND} failed for ${sessionId} (${(e as Error).name})`);
      }
    }
    if (!opened) return 'unavailable';
    if (location === 'view' && (await this.available()).has(MOVE_TO_VIEW_COMMAND)) {
      try {
        // Acts on the active chat editor, which the open above just focused; the editor is closed by the move.
        await vscode.commands.executeCommand(MOVE_TO_VIEW_COMMAND);
        this.log.info(`moved ${sessionId} into the Chat view`);
      } catch (e) {
        this.log.warn(`moving ${sessionId} into the Chat view failed (${(e as Error).name}); it stays as an editor`);
      }
    }
    return 'opened';
  }

  /** R8.1 fallback 3 (convenience only): open the chat session picker with the title on the clipboard. */
  async pickInChatHistory(title: string): Promise<void> {
    await vscode.env.clipboard.writeText(title);
    const cmds = await this.available();
    await vscode.commands.executeCommand('workbench.action.chat.open');
    // pickAgentSession is registered once the Chat view exists; refresh the cache after opening it.
    this.commands = undefined;
    const refreshed = await this.available();
    const pick = PICK_SESSION_COMMANDS.find((c) => refreshed.has(c) || cmds.has(c));
    if (pick) await vscode.commands.executeCommand(pick);
  }
}
