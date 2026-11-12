import * as z from 'zod/mini';

/** Typed, zod-validated messages between the Statistics webview and the host (R7.20), validated on both sides. */

const id = z.int().check(z.minimum(0));
const count = z.number().check(z.minimum(0));
const nullableNumber = z.nullable(z.number());
const source = z.enum(['vscode', 'vscode-insiders', 'copilot-cli']);
const list = z.array(z.string().check(z.maxLength(500))).check(z.maxLength(500));
export const BUCKETS = ['auto', 'day', 'week', 'month'] as const;
/** R9.3 – the exportable tables, one per widget. */
export const STATS_TABLES = ['kpis', 'activity', 'workspaces', 'models', 'modes', 'tools', 'heatmap', 'top'] as const;
export type StatsTable = (typeof STATS_TABLES)[number];

export const StatsFilterSchema = z.object({
  after: z.optional(z.number()),
  before: z.optional(z.number()),
  sources: z.optional(list),
  groups: z.optional(list),
  models: z.optional(list),
  modes: z.optional(list),
  bucket: z.optional(z.enum(BUCKETS)),
});
export type StatsFilterMessage = z.infer<typeof StatsFilterSchema>;

const share = z.object({ name: z.string(), turns: count, credits: nullableNumber });
const topSession = z.object({ key: z.string(), title: z.string(), workspaceName: z.string(), source, prompts: count, credits: nullableNumber, durationMs: count });

export const StatsResultSchema = z.object({
  kpis: z.object({
    sessions: count,
    turns: count,
    prompts: count,
    meaningfulPrompts: count,
    canceled: count,
    toolCalls: count,
    activeDays: count,
    promptTokens: nullableNumber,
    completionTokens: nullableNumber,
    credits: nullableNumber,
    tokenCoverage: nullableNumber,
    creditCoverage: nullableNumber,
    avgPromptsPerSession: nullableNumber,
  }),
  bucket: z.enum(['day', 'week', 'month']),
  activity: z.array(z.object({ bucket: z.string(), source, prompts: count, credits: nullableNumber })),
  workspaces: z.array(z.object({ id: z.string(), label: z.string(), sessions: count, prompts: count, credits: nullableNumber, lastActivityAt: z.number() })),
  models: z.array(share),
  modes: z.array(share),
  tools: z.array(z.object({ tool: z.string(), calls: count })),
  heatmap: z.array(z.array(count).check(z.length(24))).check(z.length(7)),
  top: z.object({ byPrompts: z.array(topSession), byCredits: z.array(topSession), byDuration: z.array(topSession) }),
  facets: z.object({ sources: z.array(source), groups: z.array(z.object({ id: z.string(), label: z.string() })), models: z.array(z.string()), modes: z.array(z.string()) }),
  range: z.object({ from: nullableNumber, to: nullableNumber }),
  tookMs: z.number(),
});
export type StatsResultMessage = z.infer<typeof StatsResultSchema>;

export const StatsHostToWebviewSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('init'), filter: z.optional(StatsFilterSchema) }),
  z.object({ type: z.literal('data'), requestId: id, result: StatsResultSchema }),
  z.object({ type: z.literal('error'), requestId: z.optional(id), message: z.string() }),
]);
export type StatsHostToWebview = z.infer<typeof StatsHostToWebviewSchema>;

export const StatsWebviewToHostSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }),
  z.object({ type: z.literal('query'), requestId: id, filter: StatsFilterSchema }),
  /** Widget 6 click: a `tool:` search in the Search Panel. */
  z.object({ type: z.literal('searchTool'), tool: z.string().check(z.maxLength(300)) }),
  z.object({ type: z.literal('openSession'), key: z.string().check(z.maxLength(300)) }),
  z.object({ type: z.literal('export'), table: z.enum(STATS_TABLES), filter: StatsFilterSchema }),
  /** N5 – the first data set is rendered (all widgets). */
  z.object({ type: z.literal('rendered'), requestId: id }),
]);
export type StatsWebviewToHost = z.infer<typeof StatsWebviewToHostSchema>;
