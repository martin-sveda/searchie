import * as z from 'zod/mini';

/**
 * Typed, zod-validated messages between the Preview webview and the host (R7.20). Shared by both bundles;
 * `zod/mini` keeps the host and webview bundles small.
 */

const index = z.int().check(z.minimum(0));
const term = z.string().check(z.maxLength(200));
const terms = z.array(term).check(z.maxLength(64));

const PartSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('markdown'), text: z.string() }),
  z.object({ kind: z.literal('thinking'), text: z.string() }),
  z.object({ kind: z.literal('tool'), tool: z.string(), args: z.string() }),
]);

export const PreviewFileSchema = z.object({ label: z.string(), path: z.string(), exists: z.boolean() });

export const PreviewTurnSchema = z.object({
  index,
  timestamp: z.number(),
  prompt: z.string(),
  parts: z.array(PartSchema),
  /** Indexes into `PreviewData.files`. */
  files: z.array(index),
  model: z.optional(z.string()),
  mode: z.optional(z.string()),
  canceled: z.boolean(),
  noise: z.boolean(),
});

export const PreviewDataSchema = z.object({
  title: z.string(),
  workspaceName: z.string(),
  sourceLabel: z.string(),
  createdAt: z.number(),
  lastActivityAt: z.number(),
  models: z.array(z.string()),
  modes: z.array(z.string()),
  promptTokens: z.optional(z.number()),
  completionTokens: z.optional(z.number()),
  credits: z.optional(z.number()),
  turnCount: z.int(),
  hiddenTurns: z.int(),
  files: z.array(PreviewFileSchema),
  turns: z.array(PreviewTurnSchema),
});
export type PreviewData = z.infer<typeof PreviewDataSchema>;
export type PreviewTurn = z.infer<typeof PreviewTurnSchema>;

export const HostToWebviewSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('init'),
    data: PreviewDataSchema,
    terms,
    scrollTo: z.optional(z.int()),
    redacted: z.boolean(),
    canOpenInChat: z.boolean(),
    openInChatLabel: z.string(),
    newWindowLabel: z.string(),
  }),
  z.object({ type: z.literal('reveal'), terms, scrollTo: z.optional(z.int()) }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);
export type HostToWebview = z.infer<typeof HostToWebviewSchema>;

export const WebviewToHostSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }),
  z.object({ type: z.literal('openFile'), file: index }),
  z.object({ type: z.literal('openLink'), href: z.string().check(z.maxLength(4096)) }),
  z.object({ type: z.literal('setRedacted'), redacted: z.boolean() }),
  z.object({ type: z.literal('openInChat') }),
  z.object({ type: z.literal('openNewWindow') }),
  z.object({ type: z.literal('copySessionId') }),
]);
export type WebviewToHost = z.infer<typeof WebviewToHostSchema>;
