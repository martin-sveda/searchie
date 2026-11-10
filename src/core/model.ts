import { z } from 'zod';

/** Normalized session model (SPEC §4.4). Shared by parsers, the indexer, the worker RPC and the UI. */

export const SOURCE_IDS = ['vscode', 'vscode-insiders', 'copilot-cli'] as const;
export const SourceIdSchema = z.enum(SOURCE_IDS);
export type SourceId = z.infer<typeof SourceIdSchema>;

export const SOURCE_LABELS: Record<SourceId, string> = {
  vscode: 'VS Code',
  'vscode-insiders': 'Insiders',
  'copilot-cli': 'Copilot CLI',
};

export const ToolCallSchema = z.object({ tool: z.string(), args: z.string() });
export type ToolCall = z.infer<typeof ToolCallSchema>;

/** Ordered response parts, only produced for Preview (never indexed as such). */
export const TurnPartSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('markdown'), text: z.string() }),
  z.object({ kind: z.literal('thinking'), text: z.string() }),
  z.object({ kind: z.literal('tool'), tool: z.string(), args: z.string() }),
]);
export type TurnPart = z.infer<typeof TurnPartSchema>;

const optionalNumber = z.number().finite().optional();

export const TurnSchema = z.object({
  sessionId: z.string(),
  index: z.number().int().nonnegative(),
  timestamp: z.number(),
  prompt: z.string(),
  response: z.string(),
  thinking: z.string(),
  toolCalls: z.array(ToolCallSchema),
  files: z.array(z.string()),
  model: z.string().optional(),
  mode: z.string().optional(),
  promptTokens: optionalNumber,
  completionTokens: optionalNumber,
  credits: optionalNumber,
  elapsedMs: optionalNumber,
  hidden: z.boolean(),
  canceled: z.boolean(),
  noise: z.boolean(),
  parts: z.array(TurnPartSchema).optional(),
});
export type Turn = z.infer<typeof TurnSchema>;

export const SessionCopySchema = z.object({ workspaceId: z.string(), workspaceName: z.string(), filePath: z.string() });

export const SessionMetaSchema = z.object({
  key: z.string(),
  id: z.string(),
  source: SourceIdSchema,
  workspaceId: z.string(),
  workspaceName: z.string(),
  workspaceUri: z.string().optional(),
  filePath: z.string(),
  copies: z.array(SessionCopySchema),
  title: z.string(),
  createdAt: z.number(),
  lastActivityAt: z.number(),
  turnCount: z.number().int(),
  promptCount: z.number().int(),
  noisePromptCount: z.number().int(),
  canceledCount: z.number().int(),
  toolCallCount: z.number().int(),
  models: z.record(z.string(), z.number()),
  modes: z.record(z.string(), z.number()),
  tools: z.record(z.string(), z.number()),
  promptTokens: optionalNumber,
  completionTokens: optionalNumber,
  credits: optionalNumber,
  elapsedMs: optionalNumber,
  sizeBytes: z.number(),
});
export type SessionMeta = z.infer<typeof SessionMetaSchema>;

/** Output of a parser: one session with its turns, before workspace/file metadata is attached. */
export interface ParsedSession {
  id: string;
  title: string;
  customTitle: boolean;
  createdAt: number;
  lastActivityAt: number;
  turns: Turn[];
  diagnostics: ParseDiagnostics;
}

export interface ParseDiagnostics {
  lines: number;
  malformed: number;
  oversized: number;
  unknownKinds: number;
}

/** R4.6 – lenient validation of a reconstructed VS Code session: only `sessionId` and `requests` are required. */
export const RawVsCodeSessionSchema = z.looseObject({
  sessionId: z.string().min(1),
  requests: z.array(z.unknown()),
  customTitle: z.string().optional().catch(undefined),
  creationDate: z.number().optional().catch(undefined),
  lastMessageDate: z.number().optional().catch(undefined),
});
export type RawVsCodeSession = z.infer<typeof RawVsCodeSessionSchema>;

export const sessionKey = (source: SourceId, sessionId: string): string => `${source}:${sessionId}`;
export const workspaceKey = (source: SourceId, idPart: string): string => `${source}:${idPart}`;
export const EMPTY_WINDOW = 'empty-window';
