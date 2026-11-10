// Structure-only survey of VS Code chat sessions (keys, kinds, counts – never values).
// Usage: ../node.sh survey-vscode.mjs <root containing workspaceStorage/ and globalStorage/>
import fs from 'node:fs';
import path from 'node:path';
import { reconstructFromJsonlAsync } from './vendor/replay.mjs';
import { discoverVsCode } from './discover.mjs';

const root = process.argv[2] || '/tmp/searchie-spike/data/vscode';
const ENUM_RE = /^[A-Za-z0-9][A-Za-z0-9_.\-]{0,60}$/;
const out = { files: 0, lineKinds: {}, sessionKeys: {}, requestKeys: {}, messageKeys: {}, partKinds: {}, partKeys: {},
  variableKinds: {}, modeInfoKeys: {}, modeIds: {}, agentIds: {}, resultKeys: {}, contentRefKeys: {}, versions: {},
  requests: 0, maxRequests: 0 };
const bump = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };
const keysOf = (o, target, prefix = '') => { if (o && typeof o === 'object' && !Array.isArray(o)) for (const k of Object.keys(o)) bump(target, prefix + k); };
const enumVal = (v) => (typeof v === 'string' && ENUM_RE.test(v) ? v : typeof v === 'string' ? '<custom>' : `<${typeof v}>`);

for (const f of discoverVsCode(root)) {
  out.files++;
  const s = await reconstructFromJsonlAsync(f.path, out.lineKinds);
  if (!s) continue;
  keysOf(s, out.sessionKeys);
  if (s.version !== undefined) bump(out.versions, String(s.version));
  const reqs = Array.isArray(s.requests) ? s.requests : [];
  out.requests += reqs.length;
  out.maxRequests = Math.max(out.maxRequests, reqs.length);
  for (const r of reqs) {
    if (!r || typeof r !== 'object') continue;
    keysOf(r, out.requestKeys);
    keysOf(r.message, out.messageKeys);
    keysOf(r.modeInfo, out.modeInfoKeys);
    keysOf(r.result, out.resultKeys);
    if (r.modeInfo) bump(out.modeIds, enumVal(r.modeInfo.modeId ?? r.modeInfo.kind));
    if (r.agent) bump(out.agentIds, enumVal(r.agent.id));
    for (const v of r.variableData?.variables ?? []) bump(out.variableKinds, enumVal(v?.kind));
    for (const c of (r.contentReferences ?? []).slice(0, 5)) keysOf(c, out.contentRefKeys);
    for (const p of Array.isArray(r.response) ? r.response : []) {
      const kind = p?.kind === undefined ? '<none:markdown>' : enumVal(p.kind);
      bump(out.partKinds, kind);
      keysOf(p, (out.partKeys[kind] ||= {}));
    }
  }
}
process.stdout.write(JSON.stringify(out, null, 1) + '\n');
