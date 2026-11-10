// S3 survey: structure-only report over ~/.copilot/session-state/*/
// Never prints string values except an explicit allowlist of enum-like fields
// (validated against a strict identifier regex) and version numbers.
//
// Usage: ../node.sh survey.mjs [root] > out/survey.json
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';

const root = process.argv[2] || path.join(os.homedir(), '.copilot', 'session-state');

const ENUM_PATHS = new Set([
  'data.agentMode', 'data.mode', 'data.source', 'data.reason', 'data.outcome', 'data.status',
  'data.attachments[].type', 'data.attachments[].mimeType', 'data.toolRequests[].type',
  'data.shutdownType', 'data.producer', 'data.kind', 'data.role', 'data.success',
  'data.result.type', 'data.error.type', 'data.context.hostType', 'data.permissionMode',
  'data.selectedModel', 'data.newModel', 'data.previousModel', 'data.model',
  'data.reasoningEffort', 'data.interactionType', 'data.trigger', 'data.delivery', 'data.newMode',
  'data.isAutopilotContinuation', 'data.usage.initiator', 'data.usage.interactionType', 'data.usage.aiCreditsStatus',
  'data.usage.finishReason', 'data.fileEdits[].kind', 'data.success', 'data.checkpoint',
]);
const ENUM_RE = /^[A-Za-z0-9][A-Za-z0-9_.\-/:]{0,40}$/;
const VERSION_PATHS = new Set(['data.copilotVersion', 'data.version', 'data.cliVersion', 'data.producerVersion']);
const VERSION_RE = /^\d+\.\d+\.\d+([-.+][0-9A-Za-z.]+)?$/;

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
const OPAQUE = new Set(['toolTelemetry', 'result', 'requestedSchema', 'reasoningBlocks', 'structuredContent', 'items', 'selection', 'modelMetrics', 'properties']);

const report = {
  root: '<copilot session-state>',
  sessions: 0,
  dirEntries: {},
  lockVariants: {},
  workspaceYamlKeys: {},
  workspaceYamlEnums: {},
  agentIdByType: {},
  grouping: { userMessages: 0, distinctUserInteractionIds: 0, assistantMsgsMatchingAUserInteraction: 0, assistantMsgs: 0, userMsgsWithAgentId: 0, subagentAssistantMsgs: 0, cwdEqualsGitRoot: 0, cwdUnderGitRoot: 0, cwdOutsideGit: 0 },
  events: {},           // type -> { count, keys: { path: {types, count} }, enums: { path: {value: count} } }
  topLevelEventKeys: {},
  versions: {},
  perSession: { userMessages: [], assistantMessages: [], eventsBytes: [], lines: [] },
  parseErrors: 0,
};

function bump(obj, key, n = 1) { obj[key] = (obj[key] || 0) + n; }

function walk(value, p, depth, ev) {
  const t = typeOf(value);
  const slot = (ev.keys[p] ||= { types: {}, count: 0 });
  slot.count++;
  bump(slot.types, t);
  if (t === 'string') {
    if (ENUM_PATHS.has(p)) {
      const e = (ev.enums[p] ||= {});
      const v = p === 'data.source' ? `${value.split('-')[0]}` : value;
      bump(e, ENUM_RE.test(v) ? v : '<non-identifier>');
    }
    if (VERSION_PATHS.has(p) && VERSION_RE.test(value)) bump(report.versions, value);
  } else if (t === 'boolean' && ENUM_PATHS.has(p)) {
    bump((ev.enums[p] ||= {}), String(value));
  }
  if (depth >= 4) return;
  // Subtrees whose nested key names can carry content-derived identifiers: record presence only.
  if (OPAQUE.has(p.split('.').pop().replace('[]', ''))) return;
  if (t === 'object') {
    for (const k of Object.keys(value)) {
      // Map-like objects keyed by data (e.g. modelMetrics keyed by model id) collapse to <key>.
      const key = /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && k.length <= 40 ? k : '<key>';
      walk(value[k], `${p}.${key}`, depth + 1, ev);
    }
  } else if (t === 'array') {
    for (const item of value.slice(0, 50)) walk(item, `${p}[]`, depth + 1, ev);
  }
}

async function surveyEvents(file) {
  let users = 0, assistants = 0, lines = 0;
  const interactions = new Set();
  const rl = readline.createInterface({ input: fs.createReadStream(file, { flags: 'r' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    lines++;
    let obj;
    try { obj = JSON.parse(line); } catch { report.parseErrors++; continue; }
    const type = typeof obj.type === 'string' ? obj.type : '<no-type>';
    const ev = (report.events[type] ||= { count: 0, keys: {}, enums: {} });
    ev.count++;
    for (const k of Object.keys(obj)) bump(report.topLevelEventKeys, `${k}:${typeOf(obj[k])}`);
    if (obj.data !== undefined) walk(obj.data, 'data', 0, ev);
    if (obj.agentId) bump(report.agentIdByType, type);
    if (type === 'user.message') {
      users++; report.grouping.userMessages++;
      if (obj.agentId) report.grouping.userMsgsWithAgentId++;
      if (obj.data?.interactionId) interactions.add(obj.data.interactionId);
    }
    if (type === 'assistant.message') {
      assistants++; report.grouping.assistantMsgs++;
      if (interactions.has(obj.data?.interactionId)) report.grouping.assistantMsgsMatchingAUserInteraction++;
      if (obj.agentId || obj.data?.parentToolCallId) report.grouping.subagentAssistantMsgs++;
    }
  }
  report.grouping.distinctUserInteractionIds += interactions.size;
  report.perSession.userMessages.push(users);
  report.perSession.assistantMessages.push(assistants);
  report.perSession.lines.push(lines);
}

function yamlKeys(file) {
  const text = fs.readFileSync(file, 'utf8');
  const cwd = /^cwd:\s*(.+)$/m.exec(text)?.[1]?.trim();
  const gitRoot = /^git_root:\s*(.+)$/m.exec(text)?.[1]?.trim();
  if (cwd && gitRoot && cwd === gitRoot) report.grouping.cwdEqualsGitRoot++;
  else if (cwd && gitRoot && cwd.startsWith(gitRoot)) report.grouping.cwdUnderGitRoot++;
  else if (cwd && !gitRoot) report.grouping.cwdOutsideGit++;
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*):/.exec(line);
    if (m) bump(report.workspaceYamlKeys, m[1]);
    const ev = /^(client_name|host_type|user_named):\s*(\S+)\s*$/.exec(line);
    if (ev && ENUM_RE.test(ev[2])) bump(report.workspaceYamlEnums, `${ev[1]}=${ev[2]}`);
    if (/^(cwd|git_root):/.test(line)) bump(report.workspaceYamlEnums, `${line.split(':')[0]}=<path>`);
    const n = /^\s+([A-Za-z_][A-Za-z0-9_]*):/.exec(line);
    if (n) bump(report.workspaceYamlKeys, `  (nested) ${n[1]}`);
  }
}

const summarize = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return { n: s.length, min: s[0], median: s[Math.floor(s.length / 2)], max: s[s.length - 1], sum: s.reduce((a, b) => a + b, 0) };
};

for (const dirent of fs.readdirSync(root, { withFileTypes: true })) {
  if (!dirent.isDirectory()) continue;
  const dir = path.join(root, dirent.name);
  report.sessions++;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const name = e.name.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<uuid>').replace(/\d+/g, '<n>');
    bump(report.dirEntries, `${name}${e.isDirectory() ? '/' : ''}`);
    if (/\.(lock|hold)$/.test(e.name)) bump(report.lockVariants, name);
  }
  const ev = path.join(dir, 'events.jsonl');
  if (fs.existsSync(ev)) {
    report.perSession.eventsBytes.push(fs.statSync(ev).size);
    await surveyEvents(ev);
  }
  const ws = path.join(dir, 'workspace.yaml');
  if (fs.existsSync(ws)) yamlKeys(ws);
}

report.perSession = Object.fromEntries(Object.entries(report.perSession).map(([k, v]) => [k, summarize(v)]));
// Stable output: events sorted by count
report.events = Object.fromEntries(Object.entries(report.events).sort((a, b) => b[1].count - a[1].count));
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
