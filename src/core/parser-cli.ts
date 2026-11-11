import path from 'node:path';
import { readWorkspaceYaml } from './cli-sources';
import type { ParsedSession, Turn, TurnPart } from './model';
import { DEFAULT_MAX_LINE_CHARS, deriveTitle, type ParseOptions, SessionParseError } from './parser-vscode';
import { capText, oneLine } from './text';
import { forEachJsonlLineAsync } from './vendor/replay';

/** Copilot CLI `events.jsonl` parser (SPEC §4.3, spike S3). Own implementation; streaming, read-only. */

/** R4.16 – bump to force a re-index of every CLI session. */
export const CLI_PARSER_VERSION = 1;
const MAX_TOOL_ARGS = 2 * 1024;

/** Event types that are parsed; everything else is skipped before JSON.parse (rule: data minimisation). */
const HANDLED = new Set([
  'session.start',
  'session.resume',
  'session.model_change',
  'session.mode_changed',
  'user.message',
  'assistant.message',
  'tool.execution_start',
  'tool.execution_complete',
  'session.usage_record',
  'assistant.turn_end',
  'abort',
]);
const IGNORED = new Set([
  'system.message',
  'session.usage_checkpoint',
  'session.shutdown',
  'session.binary_asset',
  'session.title_changed',
  'assistant.turn_start',
]);
const IGNORED_PREFIXES = ['hook.', 'permission.', 'external_tool.', 'model.', 'subagent.'];
const TYPE_FIRST = /^\{\s*"type"\s*:\s*"([^"\\]{1,100})"/;
const FILE_TOOLS = new Set(['view', 'edit', 'create', 'grep', 'glob']);
const ARG_KEYS = ['path', 'paths', 'command', 'pattern', 'query', 'url', 'skill'];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const time = (v: unknown): number | undefined => {
  const t = typeof v === 'string' ? Date.parse(v) : Number.NaN;
  return Number.isFinite(t) ? t : undefined;
};

const isIgnored = (type: string): boolean => IGNORED.has(type) || IGNORED_PREFIXES.some((p) => type.startsWith(p));

interface TurnAcc {
  turn: Turn;
  response: string[];
  thinking: string[];
  files: Set<string>;
  models: Map<string, number>;
  fallbackModel?: string;
  tokensSeen: boolean;
  promptTokens: number;
  completionTokens: number;
  creditsSeen: boolean;
  credits: number;
  lastTurnEnd?: number;
  parts: TurnPart[];
}

function toolArgs(args: unknown): string {
  if (!isObj(args)) return '';
  const out: string[] = [];
  for (const k of ARG_KEYS) {
    const v = args[k];
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) for (const x of v) if (typeof x === 'string') out.push(x);
  }
  return capText(out.join(' '), MAX_TOOL_ARGS);
}

export interface CliParseDiagnostics {
  lines: number;
  malformed: number;
  oversized: number;
  unknownKinds: number;
}

/** Parses one CLI session directory's `events.jsonl` (+ `workspace.yaml` for title and dates). */
export async function parseCliFile(file: { path: string }, opts: ParseOptions): Promise<ParsedSession | null> {
  const diagnostics: CliParseDiagnostics = { lines: 0, malformed: 0, oversized: 0, unknownKinds: 0 };
  const withParts = opts.withParts === true;
  const cap = (s: string): string => capText(s, opts.maxFieldChars);
  const dir = path.dirname(file.path);
  let sessionId: string | undefined;
  let startTime: number | undefined;
  let lastEventTs = 0;
  let currentModel: string | undefined;
  let currentMode: string | undefined;
  let handledEvents = 0;
  const accs: TurnAcc[] = [];
  let acc: TurnAcc | undefined;

  const onEvent = (type: string, e: Obj): void => {
    handledEvents++;
    const d = isObj(e.data) ? e.data : {};
    const ts = time(e.timestamp);
    if (ts !== undefined) lastEventTs = Math.max(lastEventTs, ts);
    const sub = e.agentId !== undefined && e.agentId !== null;
    switch (type) {
      case 'session.start':
        sessionId ??= str(d.sessionId);
        startTime ??= time(d.startTime) ?? ts;
        currentModel = str(d.selectedModel) ?? currentModel;
        return;
      case 'session.resume':
        currentModel = str(d.selectedModel) ?? currentModel;
        return;
      case 'session.model_change':
        currentModel = str(d.newModel) ?? currentModel;
        return;
      case 'session.mode_changed':
        currentMode = str(d.newMode) ?? currentMode;
        return;
      case 'user.message': {
        if (sub) return;
        const prompt = cap(str(d.content) ?? '');
        const files = new Set<string>();
        if (Array.isArray(d.attachments)) {
          for (const a of d.attachments) {
            if (!isObj(a) || (a.type !== 'file' && a.type !== 'selection')) continue;
            const f = str(a.path) ?? str(a.filePath);
            if (f) files.add(f);
          }
        }
        acc = {
          turn: {
            sessionId: '',
            index: accs.length,
            timestamp: ts ?? 0,
            prompt,
            response: '',
            thinking: '',
            toolCalls: [],
            files: [],
            mode: str(d.agentMode) ?? currentMode ?? 'interactive',
            hidden: str(d.source) !== undefined || d.isAutopilotContinuation === true,
            canceled: false,
            noise: opts.isNoise(prompt),
          },
          response: [],
          thinking: [],
          files,
          models: new Map(),
          fallbackModel: currentModel,
          tokensSeen: false,
          promptTokens: 0,
          completionTokens: 0,
          creditsSeen: false,
          credits: 0,
          parts: [],
        };
        accs.push(acc);
        return;
      }
    }
    if (!acc) return;
    switch (type) {
      case 'assistant.message': {
        // Sub-agent output (agentId or parentToolCallId) is never part of the response.
        if (sub || d.parentToolCallId !== undefined) return;
        const text = str(d.content);
        const reasoning = str(d.reasoningText);
        if (reasoning) {
          acc.thinking.push(reasoning);
          if (withParts) acc.parts.push({ kind: 'thinking', text: reasoning });
        }
        if (text) {
          acc.response.push(text);
          if (withParts) acc.parts.push({ kind: 'markdown', text });
        }
        const model = str(d.model);
        if (model) acc.models.set(model, (acc.models.get(model) ?? 0) + 1);
        return;
      }
      case 'tool.execution_start': {
        const name = str(d.toolName);
        if (!name || name === 'report_intent') return;
        const server = str(d.mcpServerName);
        const tool = server ? `${server}/${str(d.mcpToolName) ?? name}` : name;
        const args = toolArgs(d.arguments);
        acc.turn.toolCalls.push({ tool, args });
        if (withParts) acc.parts.push({ kind: 'tool', tool, args });
        if (FILE_TOOLS.has(name) && isObj(d.arguments)) {
          const p = str(d.arguments.path);
          if (p) acc.files.add(p);
        }
        return;
      }
      case 'tool.execution_complete':
        // Only file paths; `result` is never read (R4.9).
        if (Array.isArray(d.fileEdits)) for (const fe of d.fileEdits) if (isObj(fe) && str(fe.path)) acc.files.add(fe.path as string);
        return;
      case 'session.usage_record': {
        const u = isObj(d.usage) ? d.usage : {};
        const input = num(u.inputTokens);
        const output = num(u.outputTokens);
        if (input !== undefined || output !== undefined) acc.tokensSeen = true;
        acc.promptTokens += input ?? 0;
        acc.completionTokens += output ?? 0;
        const nano = isObj(u.copilotUsage) ? num(u.copilotUsage.totalNanoAiu) : undefined;
        if (u.aiCreditsStatus === 'complete' && nano !== undefined) {
          acc.creditsSeen = true;
          acc.credits += nano / 1e9;
        }
        return;
      }
      case 'assistant.turn_end':
        if (!sub && ts !== undefined) acc.lastTurnEnd = ts;
        return;
      case 'abort':
        acc.turn.canceled = true;
        return;
    }
  };

  await forEachJsonlLineAsync(
    file.path,
    (line) => {
      if (!line.trim()) return;
      diagnostics.lines++;
      const fast = TYPE_FIRST.exec(line)?.[1];
      if (fast !== undefined && !HANDLED.has(fast)) {
        if (!isIgnored(fast)) diagnostics.unknownKinds++;
        return;
      }
      let e: unknown;
      try {
        e = JSON.parse(line);
      } catch {
        diagnostics.malformed++;
        return;
      }
      if (!isObj(e) || typeof e.type !== 'string') {
        diagnostics.malformed++;
        return;
      }
      if (!HANDLED.has(e.type)) {
        if (!isIgnored(e.type)) diagnostics.unknownKinds++;
        return;
      }
      onEvent(e.type, e);
    },
    opts.maxLineChars ?? DEFAULT_MAX_LINE_CHARS,
    () => {
      diagnostics.lines++;
      diagnostics.oversized++;
      diagnostics.malformed++;
    },
  );

  if (diagnostics.lines === 0) return null;
  if (handledEvents === 0 && diagnostics.malformed > 0) throw new SessionParseError(diagnostics.oversized > 0 ? 'oversized' : 'unparseable');

  const yaml = await readWorkspaceYaml(dir);
  const id = sessionId ?? yaml.sessionId ?? path.basename(dir);
  const turns: Turn[] = accs.map((a) => {
    let model = a.fallbackModel;
    let best = 0;
    for (const [m, n] of a.models) {
      if (n > best) {
        best = n;
        model = m;
      }
    }
    const t: Turn = {
      ...a.turn,
      sessionId: id,
      response: cap(a.response.join('\n\n')),
      thinking: cap(a.thinking.join('\n')),
      files: [...a.files],
      model,
      promptTokens: a.tokensSeen ? a.promptTokens : undefined,
      completionTokens: a.tokensSeen ? a.completionTokens : undefined,
      credits: a.creditsSeen ? Math.round(a.credits * 1e6) / 1e6 : undefined,
      elapsedMs: a.lastTurnEnd !== undefined ? Math.max(0, a.lastTurnEnd - a.turn.timestamp) : undefined,
    };
    if (withParts) t.parts = a.parts;
    return t;
  });
  const name = yaml.name?.trim();
  const createdAt = startTime ?? time(yaml.createdAt) ?? turns[0]?.timestamp ?? 0;
  return {
    id,
    title: name ? oneLine(name, 200) : deriveTitle(turns),
    customTitle: Boolean(name),
    createdAt,
    lastActivityAt: Math.max(lastEventTs, time(yaml.updatedAt) ?? 0, createdAt),
    turns,
    diagnostics,
  };
}
