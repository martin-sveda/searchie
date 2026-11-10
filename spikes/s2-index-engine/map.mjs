// Minimal session → turns mapping for indexing (SPEC §4.2, §4.3 as resolved in S3, §5.4).
import { reconstructFromJsonlAsync, forEachJsonlLineAsync, stripImageData, skipQuotedString, consumeBalancedObject } from './vendor/replay.mjs';
import fs from 'node:fs';

const MAX_FIELD = 64 * 1024;
const MAX_TOOL = 2 * 1024;
const cap = (s, n = MAX_FIELD) => (s.length > n ? s.slice(0, n) : s);
const str = (v) => (typeof v === 'string' ? v : v && typeof v.value === 'string' ? v.value : '');

// Implements SPEC R5.10 (rules derived from the Searchie prototype isNoise concept; not copied code).
const NOISE_RE = /^(@agent\s+)?(continue|try again|retry|stop|cancel|abort|y|n|yes|no)[.!]?$/i;
export function isNoise(prompt) {
  const t = prompt.trim();
  if (!t) return false;
  if (NOISE_RE.test(t)) return true;
  if (t.length < 80 && /continue to iterate/i.test(t)) return true;
  if (t.length <= 3 && /^[yYnN.!?]+$/.test(t)) return true;
  return /^system/i.test(t);
}

const IDENT_RE = /[A-Za-z][A-Za-z0-9]*(?:[A-Z_][a-z0-9]+)+/g;
/** R5.7 – camelCase / PascalCase / snake_case parts for the hidden aux column. */
export function identifierParts(text) {
  const out = [];
  for (const m of text.matchAll(IDENT_RE)) {
    out.push(m[0].replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase());
    if (out.length > 2000) break;
  }
  return out.join(' ');
}

/** R5.8 – full path + basename + basename without extension. */
export function expandPaths(paths) {
  const out = [];
  for (const p of paths) {
    const base = p.split(/[\\/]/).pop() ?? p;
    out.push(p, base, base.replace(/\.[^.]+$/, ''));
  }
  return out.join(' ');
}

const uriPath = (u) => (u && typeof u === 'object' ? u.fsPath ?? u.path ?? '' : typeof u === 'string' ? u : '');

// Prune-on-replay: drop fields that are never indexed (tool outputs, result metadata) right after JSON.parse.
const TOOL_KEEP = new Set(['kind', 'toolId', 'toolCallId', 'invocationMessage', 'source', 'isComplete']);
function prunePart(p) {
  if (!p || typeof p !== 'object' || p.kind !== 'toolInvocationSerialized') return p;
  for (const k of Object.keys(p)) if (!TOOL_KEEP.has(k)) delete p[k];
  return p;
}
function pruneResult(r) { if (r && typeof r === 'object') delete r.metadata; return r; }
function pruneRequest(r) {
  if (!r || typeof r !== 'object') return r;
  if (Array.isArray(r.response)) r.response.forEach(prunePart);
  pruneResult(r.result);
  return r;
}
// String-level pre-strip for very long lines: replaces never-indexed object values with null before JSON.parse.
const HEAVY_KEY_RE = /"(resultDetails|toolSpecificData|metadata)"\s*:\s*/g;
function consumeBalancedArray(raw, start) {
  let depth = 1; let i = start + 1;
  while (i < raw.length && depth > 0) {
    const ch = raw[i];
    if (ch === '[' || ch === '{') depth++; else if (ch === ']' || ch === '}') depth--; else if (ch === '"') { i = skipQuotedString(raw, i); continue; }
    i++;
  }
  return i;
}
export function preStripHeavy(raw) {
  if (raw.length < 256 * 1024) return raw;
  const parts = []; let last = 0; let m;
  HEAVY_KEY_RE.lastIndex = 0;
  while ((m = HEAVY_KEY_RE.exec(raw)) !== null) {
    const v = m.index + m[0].length; const c = raw[v];
    if (c !== '{' && c !== '[') continue;
    const end = c === '{' ? consumeBalancedObject(raw, v) : consumeBalancedArray(raw, v);
    parts.push(raw.slice(last, v), 'null'); last = end; HEAVY_KEY_RE.lastIndex = end;
  }
  if (!parts.length) return raw;
  parts.push(raw.slice(last));
  return parts.join('');
}

export function pruneVsCodeEntry(e) {
  const k = e.k ?? [];
  if (e.kind === 0) { (e.v?.requests ?? []).forEach(pruneRequest); return; }
  if (k[0] !== 'requests') return;
  if (k.length === 1) { if (Array.isArray(e.v)) e.v.forEach(pruneRequest); return; }
  if (k.length === 2) { pruneRequest(e.v); return; }
  if (k[2] === 'response') {
    if (k.length === 3) { if (Array.isArray(e.v)) e.v.forEach(prunePart); } else if (k.length === 4) prunePart(e.v);
    else if (k.length === 5 && !TOOL_KEEP.has(k[4])) e.v = null;
  } else if (k[2] === 'result') {
    if (k.length === 3) pruneResult(e.v); else if (k[3] === 'metadata') e.v = null;
  }
}

function vscodeTurns(s) {
  const turns = [];
  (Array.isArray(s.requests) ? s.requests : []).forEach((r, idx) => {
    if (!r || typeof r !== 'object') return;
    const response = []; const tools = []; const files = new Set();
    for (const p of Array.isArray(r.response) ? r.response : []) {
      if (!p) continue;
      if (p.kind === undefined) response.push(str(p));
      else if (p.kind === 'inlineReference') response.push(p.name ?? p.inlineReference?.name ?? uriPath(p.inlineReference?.uri ?? p.inlineReference).split('/').pop() ?? '');
      else if (p.kind === 'toolInvocationSerialized') tools.push({ tool: p.toolId ?? '', args: cap(str(p.invocationMessage), MAX_TOOL) });
      else if (p.kind === 'codeblockUri' || p.kind === 'textEditGroup') files.add(uriPath(p.uri));
    }
    for (const c of r.contentReferences ?? []) { const f = uriPath(c?.reference?.uri ?? c?.reference); if (f) files.add(f); }
    for (const v of r.variableData?.variables ?? []) if (v?.kind === 'file') { const f = uriPath(v.value?.uri ?? v.value); if (f) files.add(f); }
    const prompt = str(r.message?.text ?? r.message);
    turns.push({
      idx, ts: r.timestamp ?? s.creationDate ?? 0, prompt, response: response.join('\n'), tools, files: [...files].filter(Boolean),
      model: r.modelId, mode: r.modeInfo?.telemetryModeName ?? r.modeInfo?.kind ?? s.inputState?.mode?.id,
      promptTokens: r.promptTokens, completionTokens: r.completionTokens, credits: r.copilotCredits, elapsedMs: r.elapsedMs,
      hidden: !!(r.hiddenFromTranscript || r.isSystemInitiated), canceled: r.modelState?.value === 2,
    });
  });
  return turns;
}

export async function parseVsCodeFile(f, stats) {
  const s = f.kind === 'json' ? JSON.parse(stripImageData(fs.readFileSync(f.path, 'utf8'))) : await reconstructFromJsonlAsync(f.path, stats, pruneVsCodeEntry, preStripHeavy);
  if (s && f.kind === 'json') pruneVsCodeEntry({ kind: 0, v: s });
  if (!s || !Array.isArray(s.requests)) return null;
  const turns = vscodeTurns(s);
  const firstPrompt = turns.find((t) => !t.hidden && !isNoise(t.prompt) && t.prompt.trim())?.prompt ?? '';
  return { id: s.sessionId ?? f.path, title: s.customTitle ?? firstPrompt.slice(0, 80), createdAt: s.creationDate ?? 0, turns };
}

const CLI_SKIP = new Set(['hook.start', 'hook.end', 'permission.requested', 'permission.completed', 'external_tool.requested',
  'external_tool.completed', 'session.usage_checkpoint', 'session.shutdown', 'system.message', 'session.binary_asset',
  'assistant.turn_start', 'model.turn_started', 'model.model_call_started', 'model.captured_assignment_context',
  'model.model_call_success', 'model.message', 'model.response', 'model.turn_ended', 'model.messages_snapshot']);
const TYPE_RE = /^\{"type":"([^"]+)"/;

export async function parseCliFile(f, stats) {
  let sessionId = f.sessionId; let createdAt = 0; let model = '';
  const turns = []; let t = null;
  await forEachJsonlLineAsync(f.path, (line) => {
    const type = TYPE_RE.exec(line)?.[1];
    if (!type || CLI_SKIP.has(type)) { stats.skipped = (stats.skipped || 0) + 1; return; }
    let ev; try { ev = JSON.parse(line); } catch { stats.malformed = (stats.malformed || 0) + 1; return; }
    const d = ev.data ?? {}; const ts = Date.parse(ev.timestamp) || 0;
    if (type === 'session.start') { sessionId = d.sessionId ?? sessionId; createdAt = Date.parse(d.startTime) || ts; model = d.selectedModel ?? model; }
    else if (type === 'session.model_change') model = d.newModel ?? model;
    else if (type === 'user.message' && !ev.agentId) {
      t = { idx: turns.length, ts, prompt: d.content ?? '', response: '', tools: [], files: (d.attachments ?? []).map((a) => a.path ?? a.filePath).filter(Boolean),
        model, mode: d.agentMode ?? 'interactive', promptTokens: 0, completionTokens: 0, credits: 0, elapsedMs: 0,
        hidden: !!(d.source || d.isAutopilotContinuation), canceled: false, models: {} };
      turns.push(t);
    } else if (!t) return;
    else if (type === 'assistant.message' && !ev.agentId && !d.parentToolCallId) {
      if (d.content) t.response += (t.response ? '\n' : '') + d.content;
      if (d.model) t.model = d.model;
    } else if (type === 'tool.execution_start' && d.toolName !== 'report_intent') {
      const a = d.arguments && typeof d.arguments === 'object' ? d.arguments : {};
      const args = [a.path, a.paths, a.command, a.pattern, a.query, a.url, a.skill].flat().filter((x) => typeof x === 'string').join(' ');
      t.tools.push({ tool: d.toolName ?? '', args: cap(args, MAX_TOOL) });
    } else if (type === 'tool.execution_complete') for (const e of d.fileEdits ?? []) { if (e.path) t.files.push(e.path); }
    else if (type === 'session.usage_record') {
      const u = d.usage ?? {};
      t.promptTokens += u.inputTokens ?? 0; t.completionTokens += u.outputTokens ?? 0; t.credits += (u.copilotUsage?.totalNanoAiu ?? 0) / 1e9;
    } else if (type === 'assistant.turn_end' && !ev.agentId) t.elapsedMs = ts - t.ts;
    else if (type === 'abort') t.canceled = true;
  });
  if (!turns.length) return null;
  const firstPrompt = turns.find((x) => !x.hidden && !isNoise(x.prompt))?.prompt ?? '';
  return { id: sessionId, title: f.title ?? firstPrompt.slice(0, 80), createdAt, turns };
}

/** Builds the six FTS columns for one turn (title, prompt, response, tools, files, aux). */
export function turnText(title, t) {
  const tools = cap(t.tools.map((x) => `${x.tool} ${x.args}`).join('\n'));
  const files = cap(expandPaths([...new Set(t.files)]));
  const prompt = cap(t.prompt); const response = cap(t.response);
  const aux = cap(identifierParts(`${prompt} ${response} ${tools}`));
  return { title, prompt, response, tools, files, aux };
}
