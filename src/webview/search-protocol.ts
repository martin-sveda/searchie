import * as z from 'zod/mini';

/** Typed, zod-validated messages between the Search Panel webview and the host (R7.20), validated on both sides. */

const id = z.int().check(z.minimum(0));
const shortText = z.string().check(z.maxLength(4096));
export const SORT_VALUES = ['relevance', 'newest', 'oldest', 'prompts', 'credits'] as const;
const sort = z.enum(SORT_VALUES);
const names = z.array(z.string().check(z.maxLength(500))).check(z.maxLength(5000));

export const PanelHitSchema = z.object({
  turnIndex: id,
  column: z.enum(['title', 'prompt', 'response', 'tools', 'files']),
  /** Plain text with \x01 / \x02 around matches; rendered as text plus <mark> elements, never as HTML (R6.10). */
  snippet: z.string(),
});

export const PanelResultSchema = z.object({
  key: z.string(),
  title: z.string(),
  workspaceName: z.string(),
  source: z.enum(['vscode', 'vscode-insiders', 'copilot-cli']),
  lastActivityAt: z.number(),
  primaryModel: z.optional(z.string()),
  promptCount: z.int(),
  credits: z.optional(z.number()),
  matchCount: z.int(),
  hits: z.array(PanelHitSchema),
});
export type PanelResult = z.infer<typeof PanelResultSchema>;

export const PanelFacetsSchema = z.object({ sources: names, workspaces: names, models: names, modes: names });
export type PanelFacets = z.infer<typeof PanelFacetsSchema>;

export const SearchHostToWebviewSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('init'),
    facets: PanelFacetsSchema,
    history: names,
    /** Query to show and run; undefined restores the webview's own state. */
    query: z.optional(shortText),
    scope: z.optional(z.object({ label: z.string() })),
  }),
  z.object({
    type: z.literal('results'),
    requestId: id,
    offset: id,
    total: id,
    totalTurns: z.optional(id),
    tookMs: z.number(),
    mode: z.enum(['text', 'list']),
    fuzzy: z.boolean(),
    suggestion: z.optional(shortText),
    warnings: z.array(z.string()),
    terms: z.array(z.string()),
    results: z.array(PanelResultSchema),
  }),
  z.object({ type: z.literal('error'), requestId: z.optional(id), message: z.string() }),
  z.object({ type: z.literal('history'), history: names }),
]);
export type SearchHostToWebview = z.infer<typeof SearchHostToWebviewSchema>;

export const PANEL_ACTIONS = ['open', 'preview', 'newWindow', 'copyResume'] as const;

export const SearchWebviewToHostSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }),
  z.object({ type: z.literal('search'), requestId: id, query: shortText, sort, offset: id }),
  z.object({ type: z.literal('commit'), query: shortText }),
  z.object({ type: z.literal('action'), key: z.string().check(z.maxLength(300)), action: z.enum(PANEL_ACTIONS), turnIndex: z.optional(id) }),
  z.object({ type: z.literal('clearScope') }),
]);
export type SearchWebviewToHost = z.infer<typeof SearchWebviewToHostSchema>;
