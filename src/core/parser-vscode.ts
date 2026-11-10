import fs from 'node:fs';
import path from 'node:path';
import { type ParsedSession, RawVsCodeSessionSchema, type Turn, type TurnPart } from './model';
import { capText, oneLine, uriLikeToPath } from './text';
import {
  consumeBalanced,
  emptyReplayStats,
  type JsonObject,
  type JsonValue,
  type ReplayEntry,
  reconstructFromJsonlAsync,
  stripImageData,
} from './vendor/replay';

/** VS Code chat session parser (`.jsonl` mutation log and legacy `.json`, SPEC §4.1–4.2). */

/** R4.7 – bump to force a re-index of every file. */
export const PARSER_VERSION = 1;
export const DEFAULT_MAX_LINE_CHARS = 64 * 1024 * 1024;
const MAX_TOOL_ARGS = 2 * 1024;
const PRE_STRIP_MIN = 256 * 1024;

export interface ParseOptions {
  /** Per-field cap (R4.10); Preview passes Infinity. */
  maxFieldChars: number;
  isNoise: (prompt: string) => boolean;
  /** Keep ordered response parts for Preview. */
  withParts?: boolean;
  maxLineChars?: number;
}

type Obj = Record<string, JsonValue>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
/** A string, or `{ value: string }` (VS Code IMarkdownString). */
const textOf = (v: unknown): string => (typeof v === 'string' ? v : isObj(v) && typeof v.value === 'string' ? v.value : '');

// ---------------------------------------------------------------- prune on replay (R4.13)

const TOOL_KIND = 'toolInvocationSerialized';
const TOOL_KEEP = new Set(['kind', 'toolId', 'toolCallId', 'invocationMessage', 'source', 'isComplete', 'toolSpecificData']);

function pruneToolSpecificData(v: JsonValue | undefined): JsonValue {
  return isObj(v) && v.commandLine !== undefined ? { kind: v.kind ?? null, commandLine: v.commandLine } : null;
}

function prunePart(p: JsonValue | undefined): void {
  if (!isObj(p) || p.kind !== TOOL_KIND) return;
  for (const key of Object.keys(p)) if (!TOOL_KEEP.has(key)) delete p[key];
  if ('toolSpecificData' in p) p.toolSpecificData = pruneToolSpecificData(p.toolSpecificData);
}

function pruneRequest(r: JsonValue | undefined): void {
  if (!isObj(r)) return;
  if (Array.isArray(r.response)) for (const p of r.response) prunePart(p);
  if (isObj(r.result)) delete r.result.metadata;
}

function partAt(state: JsonValue, reqIdx: JsonValue | undefined, partIdx: JsonValue | undefined): JsonValue | undefined {
  if (!isObj(state) || !Array.isArray(state.requests) || typeof reqIdx !== 'number' || typeof partIdx !== 'number') return undefined;
  const req = state.requests[reqIdx];
  return isObj(req) && Array.isArray(req.response) ? req.response[partIdx] : undefined;
}

/** Drops never-indexed payloads right after JSON.parse. Returns false when the whole entry can be skipped. */
export function pruneVsCodeEntry(e: ReplayEntry, state: JsonValue): boolean {
  const k = e.k ?? [];
  if (e.kind === 0) {
    if (isObj(e.v) && Array.isArray(e.v.requests)) for (const r of e.v.requests) pruneRequest(r);
    return true;
  }
  if (k[0] !== 'requests') return true;
  if (k.length === 1) {
    if (Array.isArray(e.v)) for (const r of e.v) pruneRequest(r);
    return true;
  }
  if (k.length === 2) {
    pruneRequest(e.v);
    return true;
  }
  if (k[2] === 'response') {
    if (k.length === 3) {
      if (Array.isArray(e.v)) for (const p of e.v) prunePart(p);
      return true;
    }
    if (k.length === 4) {
      prunePart(e.v);
      return true;
    }
    const part = partAt(state, k[1], k[3]);
    if (!isObj(part) || part.kind !== TOOL_KIND) return true;
    const field = String(k[4]);
    if (!TOOL_KEEP.has(field)) return false;
    if (field === 'toolSpecificData') {
      if (k.length === 5) e.v = pruneToolSpecificData(e.v);
      else return k[5] === 'commandLine';
    }
    return true;
  }
  if (k[2] === 'result') {
    if (k.length === 3) {
      if (isObj(e.v)) delete e.v.metadata;
      return true;
    }
    return k[3] !== 'metadata';
  }
  return true;
}

const HEAVY_KEY_RE = /"(resultDetails|toolSpecificData|metadata)"\s*:\s*/g;

/** R4.13 – for lines > 256 KB, replaces object/array values of heavy keys with `null` before JSON.parse. */
export function preStripHeavy(raw: string): string {
  if (raw.length < PRE_STRIP_MIN) return raw;
  const parts: string[] = [];
  let last = 0;
  HEAVY_KEY_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HEAVY_KEY_RE.exec(raw)) !== null) {
    const v = m.index + m[0].length;
    const c = raw[v];
    if (c !== '{' && c !== '[') continue;
    const end = consumeBalanced(raw, v);
    parts.push(raw.slice(last, v), 'null');
    last = end;
    HEAVY_KEY_RE.lastIndex = end;
  }
  if (parts.length === 0) return raw;
  parts.push(raw.slice(last));
  return parts.join('');
}

// ---------------------------------------------------------------- mapping (§4.2)

function commandLineOf(toolSpecificData: unknown): string {
  if (!isObj(toolSpecificData)) return '';
  const cl = toolSpecificData.commandLine;
  if (typeof cl === 'string') return cl;
  if (!isObj(cl)) return '';
  return str(cl.toolEdited) ?? str(cl.userEdited) ?? str(cl.original) ?? '';
}

function inlineReferenceName(p: Obj): string {
  if (typeof p.name === 'string') return p.name;
  const ref = p.inlineReference;
  const target = isObj(ref) && ref.uri !== undefined ? ref.uri : ref;
  if (isObj(ref) && typeof ref.name === 'string') return ref.name;
  return path.posix.basename(uriLikeToPath(target).replaceAll('\\', '/'));
}

function thinkingText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string').join('\n');
  return '';
}

interface ResponseAcc {
  response: string[];
  thinking: string[];
  tools: { tool: string; args: string }[];
  files: Set<string>;
  parts: TurnPart[];
}

function pushMarkdown(acc: ResponseAcc, text: string, withParts: boolean): void {
  if (!text) return;
  acc.response.push(text);
  if (!withParts) return;
  const last = acc.parts[acc.parts.length - 1];
  if (last?.kind === 'markdown') last.text += text;
  else acc.parts.push({ kind: 'markdown', text });
}

function mapResponse(response: unknown, withParts: boolean): ResponseAcc {
  const acc: ResponseAcc = { response: [], thinking: [], tools: [], files: new Set(), parts: [] };
  if (!Array.isArray(response)) return acc;
  for (const p of response) {
    if (!isObj(p)) continue;
    const kind = p.kind;
    if (kind === undefined || kind === null || kind === 'markdownContent') {
      pushMarkdown(acc, textOf(kind === 'markdownContent' ? p.content : p), withParts);
    } else if (kind === 'inlineReference') {
      const name = inlineReferenceName(p);
      pushMarkdown(acc, withParts ? `\`${name}\`` : name, withParts);
    } else if (kind === 'thinking') {
      const t = thinkingText(p.value);
      if (t) {
        acc.thinking.push(t);
        if (withParts) acc.parts.push({ kind: 'thinking', text: t });
      }
    } else if (kind === TOOL_KIND) {
      const tool = str(p.toolId) ?? 'tool';
      const args = capText([textOf(p.invocationMessage), commandLineOf(p.toolSpecificData)].filter(Boolean).join(' '), MAX_TOOL_ARGS);
      acc.tools.push({ tool, args });
      if (withParts) acc.parts.push({ kind: 'tool', tool, args });
    } else if (kind === 'codeblockUri' || kind === 'textEditGroup') {
      const f = uriLikeToPath(p.uri);
      if (f) acc.files.add(f);
    }
  }
  return acc;
}

function requestFiles(r: Obj, files: Set<string>): void {
  if (Array.isArray(r.contentReferences)) {
    for (const c of r.contentReferences) {
      if (!isObj(c)) continue;
      const ref = c.reference;
      const f = uriLikeToPath(isObj(ref) && ref.uri !== undefined ? ref.uri : ref);
      if (f) files.add(f);
    }
  }
  const vars = isObj(r.variableData) ? r.variableData.variables : undefined;
  if (Array.isArray(vars)) {
    for (const v of vars) {
      if (!isObj(v) || v.kind !== 'file') continue;
      const val = v.value;
      const f = uriLikeToPath(isObj(val) && val.uri !== undefined ? val.uri : val);
      if (f) files.add(f);
    }
  }
}

function modeOf(r: Obj, sessionMode: string | undefined): string | undefined {
  const mi = r.modeInfo;
  if (isObj(mi)) {
    const m = str(mi.telemetryModeName) ?? str(mi.modeName) ?? str(mi.kind);
    if (m) return m;
  }
  return sessionMode;
}

function sessionModeOf(s: JsonObject): string | undefined {
  const inputState = s.inputState;
  const mode = isObj(inputState) ? inputState.mode : undefined;
  return isObj(mode) ? str(mode.id) : str(mode);
}

function mapRequest(r: Obj, index: number, sessionId: string, fallbackTs: number, sessionMode: string | undefined, opts: ParseOptions): Turn {
  const withParts = opts.withParts === true;
  const acc = mapResponse(r.response, withParts);
  requestFiles(r, acc.files);
  const prompt = capText(isObj(r.message) ? textOf(r.message.text) : textOf(r.message), opts.maxFieldChars);
  const result = isObj(r.result) ? r.result : undefined;
  const timings = result && isObj(result.timings) ? result.timings : undefined;
  const modelState = isObj(r.modelState) ? r.modelState : undefined;
  const turn: Turn = {
    sessionId,
    index,
    timestamp: num(r.timestamp) ?? fallbackTs,
    prompt,
    response: capText(acc.response.join(''), opts.maxFieldChars),
    thinking: capText(acc.thinking.join('\n'), opts.maxFieldChars),
    toolCalls: acc.tools,
    files: [...acc.files],
    model: str(r.modelId),
    mode: modeOf(r, sessionMode),
    promptTokens: num(r.promptTokens),
    completionTokens: num(r.completionTokens),
    credits: num(r.copilotCredits),
    elapsedMs: num(r.elapsedMs) ?? num(timings?.totalElapsed),
    hidden: r.hiddenFromTranscript === true || r.isSystemInitiated === true,
    canceled: modelState?.value === 2,
    noise: opts.isNoise(prompt),
  };
  if (withParts) turn.parts = acc.parts;
  return turn;
}

/** Maps a reconstructed session object to the normalized model. Returns null if R4.6 validation fails. */
export function mapVsCodeSession(raw: JsonObject, fallbackId: string, opts: ParseOptions): Omit<ParsedSession, 'diagnostics'> | null {
  const candidate = typeof raw.sessionId === 'string' && raw.sessionId ? raw : { ...raw, sessionId: fallbackId };
  const parsed = RawVsCodeSessionSchema.safeParse(candidate);
  if (!parsed.success) return null;
  const s = parsed.data;
  const sessionMode = sessionModeOf(raw);
  const createdAt = s.creationDate ?? 0;
  const turns: Turn[] = [];
  for (const r of s.requests) {
    if (!isObj(r)) continue;
    turns.push(mapRequest(r, turns.length, s.sessionId, createdAt, sessionMode, opts));
  }
  const customTitle = typeof s.customTitle === 'string' && s.customTitle.trim() !== '';
  const title = customTitle ? oneLine(s.customTitle!, 200) : deriveTitle(turns);
  const lastTs = turns.reduce((m, t) => Math.max(m, t.timestamp), 0);
  return {
    id: s.sessionId,
    title,
    customTitle,
    createdAt: createdAt || turns[0]?.timestamp || 0,
    lastActivityAt: Math.max(lastTs, s.lastMessageDate ?? 0, createdAt),
    turns,
  };
}

/** First meaningful prompt (visible, not noise, not empty), truncated to 80 chars (§4.2, R5.10). */
export function deriveTitle(turns: readonly Pick<Turn, 'prompt' | 'hidden' | 'noise'>[]): string {
  const t = turns.find((x) => !x.hidden && !x.noise && x.prompt.trim() !== '');
  return t ? oneLine(t.prompt, 80) : '';
}

export async function parseVsCodeFile(file: { path: string; kind: 'jsonl' | 'json' }, opts: ParseOptions): Promise<ParsedSession | null> {
  const stats = emptyReplayStats();
  const maxLineChars = opts.maxLineChars ?? DEFAULT_MAX_LINE_CHARS;
  let raw: JsonObject | null = null;
  if (file.kind === 'json') {
    stats.lines = 1;
    const st = await fs.promises.stat(file.path);
    if (st.size > maxLineChars) {
      stats.oversized = 1;
      stats.malformed = 1;
    } else {
      try {
        const parsed: unknown = JSON.parse(stripImageData(await fs.promises.readFile(file.path, 'utf8')));
        if (isObj(parsed)) {
          pruneVsCodeEntry({ kind: 0, v: parsed }, {});
          raw = parsed;
        } else stats.malformed = 1;
      } catch {
        stats.malformed = 1;
      }
    }
  } else {
    raw = await reconstructFromJsonlAsync(file.path, { prune: pruneVsCodeEntry, preStrip: preStripHeavy, maxLineChars, stats });
  }
  const diagnostics = { lines: stats.lines, malformed: stats.malformed, oversized: stats.oversized, unknownKinds: stats.unknownKinds };
  if (!raw) {
    if (stats.malformed > 0) throw new SessionParseError(stats.oversized > 0 ? 'oversized' : 'unparseable');
    return null;
  }
  const fallbackId = path.basename(file.path).replace(/\.(jsonl|json)$/i, '');
  const mapped = mapVsCodeSession(raw, fallbackId, opts);
  if (!mapped) throw new SessionParseError('schema');
  return { ...mapped, diagnostics };
}

/** A file that exists but can't be turned into a session; the indexer marks it `failed` (R3.5: retried on change). */
export class SessionParseError extends Error {
  constructor(readonly reason: 'oversized' | 'unparseable' | 'schema') {
    super(`session file ${reason}`);
    this.name = 'SessionParseError';
  }
}
