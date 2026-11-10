# S1 – Open a session in Copilot Chat programmatically

Status: ✅ **GO.** `vscode.open` on the local chat-session URI opens a same-workspace session as a chat editor with its full history. This was confirmed by the owner in VS Code 1.145.2. As a bonus, Copilot CLI sessions also open in VS Code through `copilotcli:/<id>`.


> **Archived.** The spike code referenced below was removed in Phase 1 after its production replacement in `src/` was tested. It is preserved in the git tag `phase0-spikes` (`git checkout phase0-spikes -- spikes/s1-chat-open`).

## Question

Is there a working, ideally public, way in VS Code 1.145.2 (Stable) to open an existing **same-workspace** chat session by its `sessionId` (R8.1)? What is the fallback, and which minimum VS Code version does it need (Q4, N9)? The probe also checks whether `node:sqlite` works inside the extension host, which S2 depends on.

## Method

1. **Source research** in public `microsoft/vscode` at the 1.145.2 commit [`c4453f8`](https://github.com/microsoft/vscode/tree/c4453f8ea430795f941c1b2ff6c9321135a74a02), cross-checked against the shipped bundle `workbench.desktop.main.js`. Earlier releases were checked through the `release/1.10x` branches.
2. **Probe extension** [`s1-chat-open/`](s1-chat-open/): plain JS, no bundler. It does the following:
   - dumps the `chat` commands and the runtime;
   - checks `node:sqlite` with FTS5 in the extension host and in a `worker_thread`;
   - provides one command per candidate, with the id prefilled from the current workspace's `chatSessions/` (newest mtime, read-only). CLI candidates are prefilled with the newest **idle** CLI session (no `inuse.*.lock`), so the probe never attaches to a live session.
3. The probe was launched with `code --extensionDevelopmentPath=…`. **Finding:** the Extension Development Host gets its own workspace storage (`workspaceStorage/ext-dev`), so it has no same-workspace sessions. The probe was therefore packed as a VSIX ([`make-vsix.sh`](s1-chat-open/make-vsix.sh), a plain zip with no vsce), installed into the owner's normal profile temporarily, tested in the real `searchie` window, and then uninstalled.
4. The owner ran each candidate and reported what was visible. Exceptions came from the probe log.

## Source findings (1.145.2)

| Item | Value | Source |
|---|---|---|
| Local session scheme | `Schemas.vscodeLocalChatSession = 'vscode-chat-session'` | `src/vs/base/common/network.ts` |
| URI shape | `vscode-chat-session://local/<base64url(utf8(sessionId)), no padding>`, built by `LocalChatSessionUri.forSession()` (`encodeBase64(…, false, true)`, authority `localChatSessionType = 'local'`) | `src/vs/workbench/contrib/chat/common/model/chatUri.ts` |
| Editor resolver | `editorResolverService.registerEditor('vscode-chat-session:**/**' → ChatEditorInput)`, plus every chat-session content-provider scheme | `src/vs/workbench/contrib/chat/browser/chat.shared.contribution.ts` (`_registerEditor`) |
| Load by resource | `ChatEditorInput` parses `vscode-chat-session` with `LocalChatSessionUri.parseLocalSessionId` and loads the session from the **current workspace's** storage | `src/vs/workbench/contrib/chat/browser/widgetHosts/editor/chatEditorInput.ts` |
| `workbench.action.chat.openSessionInEditorGroup` | `run(accessor, context?: IAgentSession \| IMarshalledAgentSessionContext)`. Any object with `resource` is accepted as the session, or `{ $mid: 25 /* MarshalledId.AgentSessionContext */, session, sessions }`. It then calls `chatWidgetService.openSession(resource, group)`. Sibling commands: `…openSessionInNewEditorGroup`, `…openSessionInNewWindow` | `src/vs/workbench/contrib/chat/browser/agentSessions/agentSessionsActions.ts` (`BaseAgentSessionAction`, `BaseOpenAgentSessionAction`) |
| `workbench.action.chat.open` | `IChatViewOpenOptions` has `query`, `mode`, `attachFiles`, … but **no session parameter** | `src/vs/workbench/contrib/chat/browser/actions/chatActions.ts` |
| History picker | `workbench.action.chat.history` **no longer exists**. It was replaced by `workbench.action.chat.pickAgentSession` (`f1: false`), which is registered only once the Chat view is instantiated | bundle; Chat view title actions |
| Chat view switch | `_chat.voice.switchToSession(resourceString)` exists only while the voice bar is active, so it's internal | bundle (`ChatViewPane`) |
| CLI session URIs | `copilotcli:/<id>` (extension-host CLI session type, `SessionIdForCLI.getResource`). Local agent host: `agent-host-copilotcli:/<id>`. Remote: `remote-<auth>-copilotcli:/<id>` | `extensions/copilot/src/extension/chatSessions/copilotcli/common/utils.ts`, `src/vs/workbench/contrib/chat/browser/copilotCliEventsUri.ts` |

## Results (owner-verified, VS Code 1.145.2, normal window, workspace `searchie`)

| # | Call | Visible result | Exception | Verdict |
|---|---|---|---|---|
| **C1** | `executeCommand('vscode.open', Uri.from({ scheme: 'vscode-chat-session', authority: 'local', path: '/' + base64url(id) }))` | **Opened as chat editor with full history** | none | ✅ **primary** |
| C2a | `executeCommand('workbench.action.chat.openSessionInEditorGroup', { resource })` | Opened as chat editor with full history | none | ✅ secondary |
| C2b | same command, `{ $mid: 25, session: { resource }, sessions: [ … ] }` | Opened as chat editor with full history | none | ✅ (no advantage over C2a) |
| C2c | `executeCommand('_chat.voice.switchToSession', resource.toString())` | — | `command '_chat.voice.switchToSession' not found` | ❌ internal, voice-only |
| C3 | `workbench.action.chat.open`, then `workbench.action.chat.pickAgentSession`, with the title on the clipboard | Picker shown; pasting the title did **not** narrow to the session | none | ⚠️ weak fallback |
| CLI-1 | `vscode.open` on `agent-host-copilotcli:/<id>` | "The editor could not be opened due to an unexpected error" | none (the error is shown in the editor) | ❌ |
| **CLI-2** | `vscode.open` on `copilotcli:/<id>` | **Opened the CLI session with its conversation history** | none | ✅ (bonus for R8.5) |

Note: none of the calls throw on failure; failures surface as an error editor. So `ChatOpener` must **pre-check** that `<workspaceStorage>/<hash>/chatSessions/<id>.jsonl` exists for the current window. The current window's hash comes from `dirname(context.storageUri)`.

### Runtime (extension host)

| | Value |
|---|---|
| `vscode.version` / `appHost` | 1.145.2 / desktop |
| `process.versions` | Node 24.22.1, Electron 43.8.3, V8 15.0, SQLite 3.53.4 |
| `require('node:sqlite')` in the extension host | ✅ FTS5 + fts5vocab + `remove_diacritics 2` |
| `node:sqlite` in a `worker_thread` with `resourceLimits.maxOldGenerationSizeMb = 256` | ✅ |
| `getCommands(true)` matching `/chat/i` | 416 (normal window), saved to `out/commands.json` (git-ignored) |

## Minimum VS Code version (Q4 / N9)

| Release | Electron → Node | `vscode-chat-session` local URI + editor resolver | `node:sqlite` unflagged (Node ≥ 22.13) |
|---|---|---|---|
| 1.100 | 34.5.1 → 20.x | ❌ | ❌ |
| 1.102 | 35.6.0 → 22.15.1 | ❌ | ✅ |
| 1.104–1.105 | 37.3–37.6 → 22.18+ | ❌ (resolver only for contributed sessions, `Schemas.vscodeChatSession`) | ✅ |
| **1.106** | **37.7.0 → 22.20.0** | ✅ `LocalChatSessionUri` + `registerEditor(vscodeLocalChatSession)` + `ChatEditorInput` local load | ✅ (experimental, prints a warning) |
| 1.145.2 | 43.8.3 → 24.22.1 | ✅ runtime-verified | ✅ runtime-verified (release candidate) |

**Answer: VS Code ≥ 1.106** (`engines.vscode: "^1.106.0"`). Versions 1.106–1.144 are verified from source only. Phase 1 CI should run an `@vscode/test-electron` smoke test on 1.106 and on Stable. Two things need checking there: that `node:sqlite` is compiled into that Electron build, and that C1 opens a fixture session.

## Decision

`ChatOpener` (R8.2) tries the following in order:

1. **Same-workspace VS Code session**, if its file exists in this window's `chatSessions/`: `vscode.open` on `vscode-chat-session://local/<base64url(sessionId)>`. ✅ confirmed
2. Fallback: `workbench.action.chat.openSessionInEditorGroup` with `{ resource }`, if it is listed in `getCommands(true)`.
3. Fallback: read-only Preview (§8 flowchart). Also offer *Pick in Chat history*: open the Chat view, run `workbench.action.chat.pickAgentSession` (or the legacy `workbench.action.chat.history` if present), and copy the title to the clipboard.
4. **Copilot CLI session**: *Open in Chat* via `vscode.open` on `copilotcli:/<sessionId>` (✅ confirmed), **plus** *Copy resume command* `copilot --resume=<sessionId>` (S3). This upgrades R8.5 from "Preview only".

## Fallbacks and open risks

- **Internal surface.** The URI scheme and command ids are not public API (K2). Mitigations: feature detection, a pre-check of the session file, the Preview fallback, and a CI smoke test per VS Code release.
- **The C3 picker didn't filter by the pasted title**, perhaps because the picker label differs from `customTitle`. That makes it a convenience only, not a reliable fallback; Preview remains the guaranteed one.
- **The `agent-host-copilotcli:` scheme fails**, even though all local CLI sessions have `client_name: vscode-agent-host`. Only `copilotcli:` works. This may change as the agent host evolves, so `ChatOpener` should try `copilotcli:` and fall back to Preview.
- **Development workflow.** The Extension Development Host uses `workspaceStorage/ext-dev`, so same-workspace opening can't be tested there with real sessions. Use fixtures for automated tests and a temporary VSIX for manual tests ([`make-vsix.sh`](s1-chat-open/make-vsix.sh)).

## Reproduce

```sh
cd spikes/s1-chat-open
# Development host (CLI candidates + runtime check; no same-workspace sessions there):
code --extensionDevelopmentPath="$PWD" /path/to/a/folder/with/chat/sessions
# Real same-workspace test:
./make-vsix.sh && code --install-extension /tmp/searchie-spike/searchie-s1-probe.vsix
#   reload the window → ⌘⇧P "Searchie Probe: S1 …" → check what opens
code --uninstall-extension searchie-spike.searchie-s1-probe
```

Logs are written to `out/` (development host) or `/tmp/searchie-spike/s1-out/` (VSIX). They contain session ids and status lines only, never titles or content.
