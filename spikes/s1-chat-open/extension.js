// S1 probe: candidates for opening an existing same-workspace chat session (SPEC R8.1).
// Read-only on all session sources. Logs never contain prompt/response text or titles.
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// When installed as a VSIX (runs from ~/.vscode/extensions) log to /tmp instead of the extensions folder.
const OUT = __dirname.includes(`${path.sep}.vscode${path.sep}extensions${path.sep}`)
  ? '/tmp/searchie-spike/s1-out'
  : path.join(__dirname, 'out');
let log;

function record(candidate, outcome, detail = '') {
  const line = `${new Date().toISOString()} [${candidate}] ${outcome}${detail ? ` – ${detail}` : ''}`;
  log.appendLine(line);
  fs.mkdirSync(OUT, { recursive: true });
  fs.appendFileSync(path.join(OUT, 'probe-log.txt'), `${line}\n`);
}

/** Same encoding as VS Code LocalChatSessionUri.forSession: base64url without padding, authority 'local'. */
function localSessionUri(sessionId) {
  const b64 = Buffer.from(sessionId, 'utf8').toString('base64url');
  return vscode.Uri.from({ scheme: 'vscode-chat-session', authority: 'local', path: `/${b64}` });
}

/** chatSessions dir of the current workspace = <workspaceStorage>/<hash>/chatSessions (sibling of our storageUri). */
function chatSessionsDir(context) {
  return context.storageUri ? path.join(path.dirname(context.storageUri.fsPath), 'chatSessions') : undefined;
}

function newestLocalSessionId(context) {
  const dir = chatSessionsDir(context);
  if (!dir || !fs.existsSync(dir)) return undefined;
  const files = fs.readdirSync(dir).filter((f) => /\.jsonl?$/.test(f))
    .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.m - a.m);
  return files[0] ? files[0].f.replace(/\.jsonl?$/, '') : undefined;
}

/** customTitle from the session log, read-only; used only for the clipboard fallback (never logged). */
function sessionTitle(context, sessionId) {
  const file = path.join(chatSessionsDir(context) ?? '', `${sessionId}.jsonl`);
  if (!fs.existsSync(file)) return undefined;
  let title;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('"customTitle"')) continue;
    try {
      const e = JSON.parse(line);
      if (e.kind === 0 && typeof e.v?.customTitle === 'string') title = e.v.customTitle;
      if (e.kind === 1 && e.k?.length === 1 && e.k[0] === 'customTitle') title = e.v;
    } catch { /* ignore */ }
  }
  return title;
}

/** Newest CLI session for this folder that is NOT in use (no inuse.*.lock) – never touch a live session. */
function newestIdleCliSessionId() {
  const root = path.join(os.homedir(), '.copilot', 'session-state');
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!fs.existsSync(root)) return undefined;
  const cands = [];
  for (const id of fs.readdirSync(root)) {
    const dir = path.join(root, id);
    try {
      const entries = fs.readdirSync(dir);
      if (!entries.includes('events.jsonl') || entries.some((e) => /^inuse\..*\.lock$/.test(e))) continue;
      const yaml = entries.includes('workspace.yaml') ? fs.readFileSync(path.join(dir, 'workspace.yaml'), 'utf8') : '';
      const cwd = /^cwd:\s*(.+)$/m.exec(yaml)?.[1]?.trim();
      cands.push({ id, sameFolder: !!folder && cwd === folder, m: fs.statSync(path.join(dir, 'events.jsonl')).mtimeMs });
    } catch { /* skip */ }
  }
  cands.sort((a, b) => Number(b.sameFolder) - Number(a.sameFolder) || b.m - a.m);
  return cands[0]?.id;
}

async function askId(prefill, prompt) {
  return vscode.window.showInputBox({ prompt, value: prefill ?? '', ignoreFocusOut: true });
}

function candidate(context, name, run, { cli = false } = {}) {
  return vscode.commands.registerCommand(`searchieProbe.${name}`, async () => {
    const prefill = cli ? newestIdleCliSessionId() : newestLocalSessionId(context);
    if (!prefill && !cli) {
      vscode.window.showWarningMessage('No chat session in this window\'s workspace storage yet. Send one chat message in this window first, start a New Chat, then rerun.');
    }
    const id = await askId(prefill,
      cli ? 'Copilot CLI session id (prefilled: newest idle CLI session, same folder first)' : 'Chat session id (prefilled: newest session of this workspace)');
    if (!id) return;
    try {
      const result = await run(id.trim());
      record(name, 'OK (no exception)', result === undefined ? '' : `returned ${JSON.stringify(result)}`);
      vscode.window.showInformationMessage(`Probe ${name}: call returned without exception. Did the session open? Report what you see.`);
    } catch (e) {
      record(name, 'EXCEPTION', String(e?.message ?? e));
      vscode.window.showErrorMessage(`Probe ${name}: ${e?.message ?? e}`);
    }
  });
}

async function dumpEnv() {
  const cmds = (await vscode.commands.getCommands(true)).filter((c) => /chat/i.test(c)).sort();
  let sqlite;
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE VIRTUAL TABLE t USING fts5(a, tokenize="unicode61 remove_diacritics 2 tokenchars '_'", prefix='2 3');
             CREATE VIRTUAL TABLE v USING fts5vocab(t, 'row'); INSERT INTO t(a) VALUES ('Členů run_in_terminal');`);
    const n = db.prepare(`SELECT count(*) n FROM t WHERE t MATCH '"clenu"'`).get().n;
    sqlite = { ok: true, sqliteVersion: db.prepare('select sqlite_version() v').get().v, fts5: n === 1, fts5vocab: db.prepare('select count(*) n from v').get().n > 0 };
    db.close();
  } catch (e) { sqlite = { ok: false, error: String(e?.message ?? e) }; }
  let worker;
  try {
    const { Worker } = require('node:worker_threads');
    worker = await new Promise((resolve) => {
      const w = new Worker(`const { parentPort } = require('node:worker_threads'); try { const { DatabaseSync } = require('node:sqlite'); new DatabaseSync(':memory:').exec('CREATE VIRTUAL TABLE t USING fts5(a)'); parentPort.postMessage({ ok: true }); } catch (e) { parentPort.postMessage({ ok: false, error: String(e) }); }`,
        { eval: true, resourceLimits: { maxOldGenerationSizeMb: 256 } });
      w.once('message', (m) => { resolve(m); w.terminate(); });
      w.once('error', (e) => resolve({ ok: false, error: String(e) }));
    });
  } catch (e) { worker = { ok: false, error: String(e?.message ?? e) }; }
  const env = {
    vscodeVersion: vscode.version, appHost: vscode.env.appHost, uiKind: vscode.env.uiKind, remoteName: vscode.env.remoteName ?? null,
    processVersions: process.versions, execArgv: process.execArgv, nodeSqliteInExtensionHost: sqlite, nodeSqliteInWorkerThread: worker,
    chatCommandCount: cmds.length,
  };
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'commands.json'), JSON.stringify(cmds, null, 1));
  fs.writeFileSync(path.join(OUT, 'env.json'), JSON.stringify(env, null, 1));
  record('env', `VS Code ${vscode.version}, Node ${process.versions.node}, Electron ${process.versions.electron}`,
    `node:sqlite host=${JSON.stringify(sqlite)} worker=${JSON.stringify(worker)}; ${cmds.length} chat commands → out/commands.json`);
}

function activate(context) {
  log = vscode.window.createOutputChannel('Searchie Probe');
  log.show(true);
  context.subscriptions.push(
    log,
    candidate(context, 'c1.vscodeOpen', (id) => vscode.commands.executeCommand('vscode.open', localSessionUri(id))),
    candidate(context, 'c2a.openSessionInEditorGroup', (id) => vscode.commands.executeCommand('workbench.action.chat.openSessionInEditorGroup', { resource: localSessionUri(id) })),
    candidate(context, 'c2b.openSessionMarshalled', (id) => {
      const session = { resource: localSessionUri(id) };
      return vscode.commands.executeCommand('workbench.action.chat.openSessionInEditorGroup', { $mid: 25 /* MarshalledId.AgentSessionContext */, session, sessions: [session] });
    }),
    candidate(context, 'c2c.switchToSession', async (id) => {
      await vscode.commands.executeCommand('workbench.action.chat.open');
      return vscode.commands.executeCommand('_chat.voice.switchToSession', localSessionUri(id).toString());
    }),
    candidate(context, 'c3.historyPicker', async (id) => {
      const title = sessionTitle(context, id);
      if (title) await vscode.env.clipboard.writeText(title);
      await vscode.commands.executeCommand('workbench.action.chat.open');
      const cmds = await vscode.commands.getCommands(true);
      const picker = ['workbench.action.chat.history', 'workbench.action.chat.pickAgentSession'].find((c) => cmds.includes(c));
      vscode.window.showInformationMessage(title ? 'Session title copied – paste to filter.' : 'No custom title found – pick the session manually.');
      if (!picker) throw new Error('no history picker command found');
      await vscode.commands.executeCommand(picker);
      return { picker, titleCopied: !!title };
    }),
    candidate(context, 'cli1.agentHost', (id) => vscode.commands.executeCommand('vscode.open', vscode.Uri.from({ scheme: 'agent-host-copilotcli', path: `/${id}` })), { cli: true }),
    candidate(context, 'cli2.extHost', (id) => vscode.commands.executeCommand('vscode.open', vscode.Uri.from({ scheme: 'copilotcli', path: `/${id}` })), { cli: true }),
    vscode.commands.registerCommand('searchieProbe.env', dumpEnv),
  );
  dumpEnv().catch((e) => record('env', 'EXCEPTION', String(e)));
}

module.exports = { activate, deactivate() {} };
