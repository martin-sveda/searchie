/** Source ids and key helpers without dependencies (kept out of model.ts so the host bundle stays small). */

export const SOURCE_IDS = ['vscode', 'vscode-insiders', 'copilot-cli'] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

export const SOURCE_LABELS: Record<SourceId, string> = {
  vscode: 'VS Code',
  'vscode-insiders': 'Insiders',
  'copilot-cli': 'Copilot CLI',
};

export const sessionKey = (source: SourceId, sessionId: string): string => `${source}:${sessionId}`;
export const workspaceKey = (source: SourceId, idPart: string): string => `${source}:${idPart}`;
export const EMPTY_WINDOW = 'empty-window';
