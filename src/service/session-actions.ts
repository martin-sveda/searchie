import type { SessionListItem } from '../store/index-db';

/** Actions on a session, implemented by Preview (§7.4) and ChatOpener (§8); used by tree and Quick Pick. */
export interface PreviewOptions {
  terms?: string[];
  turnIndex?: number;
}

export interface SessionActions {
  /** §8 flow: Open in Chat for same-workspace sessions, otherwise the other-workspace choice. */
  open(session: SessionListItem): Promise<void>;
  preview(session: SessionListItem, options?: PreviewOptions): Promise<void>;
  openWorkspaceInNewWindow(session: SessionListItem): Promise<void>;
  /** R8.5 – Copilot CLI sessions only: `copilot --resume=<id>` to the clipboard. */
  copyResumeCommand(session: SessionListItem): Promise<void>;
}
