// Generates the synthetic, anonymized fixtures in src/test/fixtures/ (structure mirrors real data
// observed in S1–S3; every string value is placeholder text). Usage: ./node.sh make-fixtures.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = new URL('../src/test/fixtures/', import.meta.url).pathname;
const W = (rel, content) => { const p = path.join(ROOT, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); };
const jsonl = (lines) => lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n';

const T0 = Date.UTC(2026, 0, 15, 9, 0, 0); // 2026-01-15T09:00:00Z
const FOLDER = '/home/user/projects/sample-app';
const fileUri = (p) => ({ $mid: 1, fsPath: p, external: `file://${p}`, path: p, scheme: 'file' });
const AGENT = { extensionId: { value: 'GitHub.copilot-chat', _lower: 'github.copilot-chat' }, extensionVersion: '0.0.0', publisherDisplayName: 'GitHub',
  extensionPublisherId: 'GitHub', extensionDisplayName: 'GitHub Copilot Chat', id: 'github.copilot.editsAgent', description: 'Edit files in your workspace in agent mode', when: 'true' };
const MODE = { kind: 'agent', isBuiltin: true, telemetryModeId: 'agent', telemetryModeName: 'Agent', permissionLevel: 'default' };
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function request(i, { text, ts, model = 'copilot/claude-sonnet-5.5', extra = {} }) {
  return {
    requestId: `request_0000000${i}`, timestamp: ts, agent: AGENT, modelId: model,
    message: { text, parts: [{ range: { start: 0, endExclusive: text.length }, editorRange: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: text.length + 1 }, text, kind: 'text' }] },
    variableData: { variables: [] }, response: [], responseId: `response_0000000${i}`, responseTimestamp: ts + 1000,
    modelState: { value: 0 }, contentReferences: [], codeCitations: [], timeSpentWaiting: 0, modeInfo: MODE, hiddenFromTranscript: false, ...extra,
  };
}

// ---------- VS Code .jsonl (kind 0/1/2, thinking/tool/markdown/inlineReference/codeblockUri/textEditGroup parts) ----------
const S1 = '11111111-1111-4111-8111-111111111111';
const WS_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const r0 = request(0, {
  text: 'How should I refactor parseJsonLine in the sample parser? Členů test with diacritics.', ts: T0,
  extra: {
    variableData: { variables: [
      { kind: 'file', id: 'file:///home/user/projects/sample-app/src/parser.ts', name: 'parser.ts', value: fileUri(`${FOLDER}/src/parser.ts`) },
      { kind: 'promptFile', id: 'prompt-instructions', name: 'prompt:copilot-instructions.md', value: fileUri(`${FOLDER}/.github/copilot-instructions.md`), automaticallyAdded: true, isRoot: true, modelDescription: 'Placeholder instructions file' },
      { kind: 'image', id: 'image-1', name: 'screenshot.png', mimeType: 'image/png', isPasted: true, value: { data: PNG_1PX } },
    ] },
    contentReferences: [{ kind: 'reference', reference: fileUri(`${FOLDER}/src/parser-utils.ts`) }],
  },
});
const r1 = request(1, { text: 'continue', ts: T0 + 600_000 });
const r2 = request(2, { text: 'Summarize the open todo items.', ts: T0 + 900_000, extra: { isSystemInitiated: true, systemInitiatedLabel: 'Placeholder system label', hiddenFromTranscript: true } });

W(`vscode/workspaceStorage/${WS_A}/workspace.json`, JSON.stringify({ folder: `file://${FOLDER}` }));
W(`vscode/workspaceStorage/${WS_A}/chatSessions/${S1}.jsonl`, jsonl([
  { kind: 0, v: { version: 3, creationDate: T0 - 5000, initialLocation: 'panel', responderUsername: 'GitHub Copilot', sessionId: S1, hasPendingEdits: false,
    requests: [], pendingRequests: [], inputState: { attachments: [], mode: { id: 'agent', kind: 'agent' }, inputText: '', selections: [], permissionLevel: 'default', contrib: {} } } },
  { kind: 1, k: ['inputState', 'inputText'], v: 'How should I refactor' },
  { kind: 2, k: ['requests'], v: [r0] },
  { kind: 2, k: ['requests', 0, 'response'], v: [{ kind: 'mcpServersStarting', didStartServerIds: [] }] },
  { kind: 2, k: ['requests', 0, 'response'], v: [{ kind: 'thinking', value: 'Placeholder reasoning: inspect the parser before answering.', id: 'thinking-1', generatedTitle: 'Inspecting parser', reasoningDurationMs: 1200 }] },
  { kind: 2, k: ['requests', 0, 'response'], v: [{ kind: 'toolInvocationSerialized', toolId: 'copilot_readFile', toolCallId: 'call-0001',
    invocationMessage: { value: `Reading [parser.ts](file://${FOLDER}/src/parser.ts)`, supportThemeIcons: false, supportHtml: false }, pastTenseMessage: { value: 'Read parser.ts' },
    isConfirmed: { type: 1 }, isComplete: true, source: { type: 'internal', label: 'Built-In' },
    resultDetails: { input: '{"filePath":"placeholder"}', output: [{ type: 'embed', isText: true, value: 'TOOL OUTPUT PLACEHOLDER – must never be indexed (R4.9)' }] } }] },
  { kind: 2, k: ['requests', 0, 'response'], v: [{ kind: 'toolInvocationSerialized', toolId: 'run_in_terminal', toolCallId: 'call-0002',
    invocationMessage: 'Running `npm test` in the terminal', isComplete: true, source: { type: 'internal', label: 'Built-In' },
    toolSpecificData: { kind: 'terminal', commandLine: { original: 'npm test' }, language: 'sh', cwd: fileUri(FOLDER) } }] },
  { kind: 2, k: ['requests', 0, 'response'], v: [{ value: 'Here is a placeholder answer. Split `parseJsonLine` into smaller helpers in ', supportThemeIcons: false, supportHtml: false, baseUri: fileUri(`${FOLDER}/`) }] },
  { kind: 2, k: ['requests', 0, 'response'], v: [{ kind: 'inlineReference', inlineReference: fileUri(`${FOLDER}/src/parser.ts`), name: 'parser.ts' }] },
  { kind: 2, k: ['requests', 0, 'response'], v: [{ kind: 'codeblockUri', uri: fileUri(`${FOLDER}/src/parser.ts`), isEdit: true },
    { kind: 'textEditGroup', uri: fileUri(`${FOLDER}/src/parser.ts`), edits: [[{ text: 'export function parseLine() {}\n', range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 } }]], done: true },
    { kind: 'undoStop', id: 'undo-1' }] },
  { kind: 1, k: ['requests', 0, 'result'], v: { timings: { firstProgress: 900, totalElapsed: 4200 }, details: 'Placeholder Model • 1x',
    metadata: { renderedUserMessage: 'ATTACHMENT CONTENT PLACEHOLDER – must never be indexed (R4.8)', toolCallRounds: [] } } },
  { kind: 1, k: ['requests', 0, 'modelState'], v: { value: 1, completedAt: T0 + 4200 } },
  { kind: 1, k: ['requests', 0, 'promptTokens'], v: 12000 },
  { kind: 1, k: ['requests', 0, 'completionTokens'], v: 800 },
  { kind: 1, k: ['requests', 0, 'copilotCredits'], v: 1 },
  { kind: 1, k: ['requests', 0, 'elapsedMs'], v: 4200 },
  { kind: 1, k: ['customTitle'], v: 'Sample parser refactoring' },
  { kind: 2, k: ['requests'], v: [r1] },
  { kind: 2, k: ['requests', 1, 'response'], v: [{ value: 'Placeholder partial answer before cancel.' }] },
  { kind: 1, k: ['requests', 1, 'modelState'], v: { value: 2, completedAt: T0 + 605_000 } },
  { kind: 7, k: ['unknownFutureKind'], v: 'ignored and counted (R4.4)' },
  { kind: 1, k: ['__proto__', 'polluted'], v: true },
  { kind: 1, k: ['requests', 0, 'constructor', 'prototype', 'polluted'], v: true },
  { kind: 2, k: ['requests'], v: [r2] },
  { kind: 2, k: ['requests', 2, 'response'], v: [{ value: 'Placeholder summary of todo items.' }] },
  { kind: 1, k: ['requests', 2, 'modelState'], v: { value: 1, completedAt: T0 + 910_000 } },
  '{"kind":1,"k":["requests",2,"elapsedMs"],"v":',
]));

// Same session id copied into a second workspace (folder → .code-workspace storage copy, see S2 finding 3).
const WS_B = 'b2c3d4e5f60718293a4b5c6d7e8f90a1';
W(`vscode/workspaceStorage/${WS_B}/workspace.json`, JSON.stringify({ workspace: `file://${FOLDER}/sample-app.code-workspace` }));
W(`vscode/workspaceStorage/${WS_B}/chatSessions/${S1}.jsonl`, fs.readFileSync(path.join(ROOT, `vscode/workspaceStorage/${WS_A}/chatSessions/${S1}.jsonl`)));

// ---------- legacy full-JSON session (.json) ----------
const S2 = '22222222-2222-4222-8222-222222222222';
const legacyReq = request(0, { text: 'Explain the sample build script.', ts: T0 - 86_400_000, model: 'copilot/gpt-6.1-sol' });
legacyReq.response = [{ value: 'Placeholder explanation of the build script.' }];
legacyReq.result = { timings: { totalElapsed: 2100 } };
legacyReq.modelState = { value: 1 };
W(`vscode/workspaceStorage/${WS_A}/chatSessions/${S2}.json`, JSON.stringify({ version: 3, creationDate: T0 - 86_400_000, initialLocation: 'panel', responderUsername: 'GitHub Copilot',
  sessionId: S2, requests: [legacyReq], inputState: { mode: { id: 'ask' } } }, null, 1));

// ---------- empty-window session ----------
const S3 = '33333333-3333-4333-8333-333333333333';
const er = request(0, { text: 'What is a placeholder?', ts: T0 + 3_600_000 });
W(`vscode/globalStorage/emptyWindowChatSessions/${S3}.jsonl`, jsonl([
  { kind: 0, v: { version: 3, creationDate: T0 + 3_599_000, initialLocation: 'panel', responderUsername: 'GitHub Copilot', sessionId: S3, hasPendingEdits: false, requests: [], pendingRequests: [], inputState: { mode: { id: 'ask' } } } },
  { kind: 2, k: ['requests'], v: [er] },
  { kind: 2, k: ['requests', 0, 'response'], v: [{ value: 'A placeholder is neutral sample text.' }] },
  { kind: 1, k: ['requests', 0, 'modelState'], v: { value: 1, completedAt: T0 + 3_602_000 } },
]));

// ---------- Copilot CLI session (events.jsonl + workspace.yaml) ----------
const C1 = '44444444-4444-4444-8444-444444444444';
const ts = (s) => new Date(T0 + 7_200_000 + s * 1000).toISOString();
let prev = null; let n = 0;
const ev = (type, data, s, extra = {}) => { const id = `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`; const e = { type, data, id, timestamp: ts(s), parentId: prev, ...extra }; prev = id; return e; };
const usage = (s, input, output, nano, extra = {}) => ev('session.usage_record', { usage: { model: 'claude-sonnet-5.5', inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
  copilotUsage: { tokenDetails: [], totalNanoAiu: nano }, aiCreditsStatus: 'complete', initiator: extra.initiator ?? 'user', interactionType: extra.interactionType ?? 'conversation-agent', finishReason: extra.finish ?? 'stop', ...extra.more } }, s, extra.top ?? {});
W(`cli/session-state/${C1}/workspace.yaml`, [`id: ${C1}`, `cwd: ${FOLDER}`, `git_root: ${FOLDER}`, 'branch: main', 'repository: sample-org/sample-app', 'host_type: github',
  'client_name: vscode-agent-host', 'name: Sample CLI session', 'user_named: false', 'summary_count: 1', 'fork_count: 0',
  `created_at: ${ts(0)}`, `updated_at: ${ts(120)}`, ''].join('\n'));
W(`cli/session-state/${C1}/inuse.12345.lock`, '');
W(`cli/session-state/${C1}/events.jsonl`, jsonl([
  ev('session.start', { sessionId: C1, version: 1, producer: 'copilot-agent', copilotVersion: '1.0.103', startTime: ts(0), selectedModel: 'claude-sonnet-5.5', reasoningEffort: 'high', contextTier: 'default',
    context: { cwd: FOLDER, gitRoot: FOLDER, branch: 'main', headCommit: '0000000000000000000000000000000000000000', repository: 'sample-org/sample-app', hostType: 'github', repositoryHost: 'github.com' }, remoteSteerable: false, alreadyInUse: false }, 0),
  ev('system.message', { role: 'system', content: 'SYSTEM PROMPT PLACEHOLDER – never indexed', interactionId: 'int-1' }, 1),
  ev('user.message', { content: 'Add a unit test for parseJsonLine.', transformedContent: '<user>Add a unit test for parseJsonLine.</user>', messageId: 'msg-1', delivery: 'idle', interactionId: 'int-1', turnId: 'turn-1',
    attachments: [{ type: 'file', path: `${FOLDER}/src/parser.ts`, displayName: 'parser.ts' }, { type: 'blob', mimeType: 'image/png', data: PNG_1PX, displayName: 'screenshot.png' }] }, 2),
  ev('assistant.turn_start', { turnId: 'turn-1', interactionId: 'int-1' }, 3),
  ev('assistant.message', { messageId: 'am-1', model: 'claude-sonnet-5.5', content: 'I will look at the parser first.', reasoningText: 'Placeholder CLI reasoning.', interactionId: 'int-1', turnId: 'turn-1',
    toolRequests: [{ toolCallId: 'tc-1', name: 'view', arguments: { path: `${FOLDER}/src/parser.ts` }, type: 'function' }] }, 4),
  usage(4, 9000, 150, 1_500_000_000, { finish: 'tool_calls', initiator: 'agent' }),
  ev('tool.execution_start', { toolCallId: 'tc-1', toolName: 'view', arguments: { path: `${FOLDER}/src/parser.ts` }, turnId: 'turn-1', model: 'claude-sonnet-5.5' }, 5),
  ev('tool.execution_complete', { toolCallId: 'tc-1', model: 'claude-sonnet-5.5', interactionId: 'int-1', turnId: 'turn-1', success: true, result: { content: 'TOOL OUTPUT PLACEHOLDER – never indexed' } }, 6),
  ev('subagent.started', { toolCallId: 'tc-2', agentName: 'explore', agentDisplayName: 'Explore', model: 'claude-sonnet-5.5' }, 7),
  ev('user.message', { content: 'SUB-AGENT PROMPT PLACEHOLDER – not a turn boundary', messageId: 'msg-sub', interactionId: 'int-1', source: 'agent-explore' }, 8, { agentId: 'agent-1' }),
  ev('assistant.message', { messageId: 'am-sub', model: 'claude-sonnet-5.5', content: 'SUB-AGENT OUTPUT PLACEHOLDER – excluded from response', parentToolCallId: 'tc-2', interactionId: 'int-1' }, 9, { agentId: 'agent-1' }),
  usage(9, 3000, 100, 500_000_000, { initiator: 'sub-agent', interactionType: 'conversation-subagent', top: { agentId: 'agent-1' } }),
  ev('subagent.completed', { toolCallId: 'tc-2', agentName: 'explore', model: 'claude-sonnet-5.5', totalToolCalls: 0, totalTokens: 3100, durationMs: 2000 }, 10),
  ev('tool.execution_start', { toolCallId: 'tc-3', toolName: 'create', arguments: { path: `${FOLDER}/test/parser.test.ts`, file_text: 'GENERATED CODE PLACEHOLDER' }, turnId: 'turn-1', model: 'claude-sonnet-5.5' }, 11),
  ev('tool.execution_complete', { toolCallId: 'tc-3', model: 'claude-sonnet-5.5', interactionId: 'int-1', turnId: 'turn-1', success: true, fileEdits: [{ path: `${FOLDER}/test/parser.test.ts`, kind: 'create' }] }, 12),
  ev('assistant.message', { messageId: 'am-2', model: 'claude-sonnet-5.5', content: 'Added a placeholder test for parseJsonLine.', interactionId: 'int-1', turnId: 'turn-1', toolRequests: [] }, 13),
  usage(13, 9500, 200, 1_600_000_000),
  ev('assistant.turn_end', { turnId: 'turn-1' }, 14),
  ev('session.model_change', { source: 'sdk', newModel: 'gpt-6.1-sol', previousModel: 'claude-sonnet-5.5', reasoningEffort: 'medium', previousReasoningEffort: 'high' }, 20),
  ev('user.message', { content: 'Now run the tests.', messageId: 'msg-2', delivery: 'idle', interactionId: 'int-2', turnId: 'turn-2', agentMode: 'autopilot' }, 30),
  ev('assistant.turn_start', { turnId: 'turn-2', interactionId: 'int-2' }, 31),
  ev('tool.execution_start', { toolCallId: 'tc-4', toolName: 'bash', arguments: { command: 'npm test', description: 'Run tests' }, turnId: 'turn-2', model: 'gpt-6.1-sol' }, 32),
  ev('abort', { reason: 'user_initiated' }, 40),
  ev('session.binary_asset', { assetId: 'sha256:placeholder', type: 'image', mimeType: 'image/png', byteLength: 68, data: PNG_1PX }, 41),
  ev('user.message', { content: 'continue', messageId: 'msg-3', delivery: 'idle', interactionId: 'int-3', turnId: 'turn-3', isAutopilotContinuation: true }, 50),
  ev('assistant.message', { messageId: 'am-3', model: 'gpt-6.1-sol', content: 'Placeholder autopilot continuation reply.', interactionId: 'int-3', turnId: 'turn-3' }, 51),
  usage(51, 4000, 50, 700_000_000),
  ev('assistant.turn_end', { turnId: 'turn-3' }, 52),
  ev('hook.start', { hookType: 'placeholder' }, 53),
  ev('session.shutdown', { shutdownType: 'routine', totalPremiumRequests: 3, totalNanoAiu: 4_300_000_000, currentModel: 'gpt-6.1-sol' }, 120),
]));
console.log(`fixtures written to ${ROOT}`);
