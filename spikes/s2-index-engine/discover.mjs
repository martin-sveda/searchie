// Source discovery (simplified from Searchie prototype session-roots.ts / findVsCodeDirs).
import fs from 'node:fs';
import path from 'node:path';

const safeReaddir = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } };

/** VS Code root: <root>/workspaceStorage/<hash>/chatSessions/*.{jsonl,json} + globalStorage/emptyWindowChatSessions. */
export function discoverVsCode(root) {
  const files = [];
  const ws = path.join(root, 'workspaceStorage');
  for (const h of safeReaddir(ws)) {
    if (!h.isDirectory()) continue;
    const dir = path.join(ws, h.name);
    let wsUri = null;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, 'workspace.json'), 'utf8'));
      wsUri = j.folder ?? j.workspace ?? null;
    } catch { /* no workspace.json */ }
    for (const f of safeReaddir(path.join(dir, 'chatSessions'))) {
      if (!/\.jsonl?$/.test(f.name)) continue;
      const p = path.join(dir, 'chatSessions', f.name);
      files.push({ path: p, kind: f.name.endsWith('.jsonl') ? 'jsonl' : 'json', source: 'vscode', workspaceId: h.name, workspaceUri: wsUri, size: fs.statSync(p).size });
    }
  }
  const empty = path.join(root, 'globalStorage', 'emptyWindowChatSessions');
  for (const f of safeReaddir(empty)) {
    if (!/\.jsonl?$/.test(f.name)) continue;
    const p = path.join(empty, f.name);
    files.push({ path: p, kind: f.name.endsWith('.jsonl') ? 'jsonl' : 'json', source: 'vscode', workspaceId: '<empty-window>', workspaceUri: null, size: fs.statSync(p).size });
  }
  return files;
}

/** Copilot CLI root: <root>/<sessionId>/events.jsonl + workspace.yaml. */
export function discoverCli(root) {
  const files = [];
  for (const d of safeReaddir(root)) {
    const p = path.join(root, d.name, 'events.jsonl');
    if (!d.isDirectory() || !fs.existsSync(p)) continue;
    let yaml = '';
    try { yaml = fs.readFileSync(path.join(root, d.name, 'workspace.yaml'), 'utf8'); } catch { /* optional */ }
    const field = (k) => new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(yaml)?.[1]?.trim();
    const folder = field('git_root') ?? field('cwd') ?? null;
    files.push({ path: p, kind: 'cli', source: 'copilot-cli', sessionId: d.name, workspaceId: `cli:${folder ?? '<unknown>'}`,
      workspaceUri: folder ? `file://${folder}` : null, title: field('name'), size: fs.statSync(p).size });
  }
  return files;
}
