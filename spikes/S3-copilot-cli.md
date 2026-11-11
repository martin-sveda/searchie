# S3 – Copilot CLI `events.jsonl` mapping and resume command

Status: ✅ **GO**. The mapping table is complete and the resume command is confirmed.

## Question

How do Copilot CLI sessions (`~/.copilot/session-state/<sessionId>/`) map to the Searchie `SessionMeta` / `Turn` model (SPEC §4.4)? What is the exact resume command (R8.5)? Should CLI sessions be grouped by repository or by cwd (Q3)?

## Method

1. Ran `s3-cli-mapping/survey.mjs` (removed in Phase 2, still in the git history) over the local session-state directory. The script prints only event `type` frequencies, key paths with value types, `workspace.yaml` keys, directory and lock-file name patterns, and version strings. String values are never printed, except an allow-list of enum-like fields such as model ids and mode names, each validated against an identifier regex. Subtrees whose key names can be content-derived (`toolTelemetry`, `result`, `requestedSchema`, …) are recorded as present only.
2. Compared the results with Searchie prototype `src/core/parser-vscode-cli.ts`.
3. Cross-checked the field semantics against the public generated schema [`github/copilot-sdk` `nodejs/src/generated/session-events.ts`](https://github.com/github/copilot-sdk/blob/main/nodejs/src/generated/session-events.ts) (event union, `UserMessageData`, `AbortReason`, `UserMessageAgentMode`, `AssistantUsageData`).
4. Took the resume syntax from the public [Copilot CLI command reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference). No `copilot` binary is installed locally; the copy bundled in VS Code (`extensions/copilot/node_modules/@github/copilot` 1.0.73) contains only the SDK.

## Results

### Dataset

| Metric | Value |
|---|---|
| Session directories | 26 (24 with `events.jsonl`; 2 contain only lock files) |
| `events.jsonl` total / median / max | 42.1 MB / 1.0 MB / 14.2 MB |
| Events | 15 761, 0 parse errors |
| `user.message` / `assistant.message` | 115 / 995 |
| CLI versions (`session.start.data.copilotVersion`) | 1.0.95, 1.0.100, 1.0.103 (pre-release builds) |
| `workspace.yaml` `client_name` | `vscode-agent-host` in 24/24 sessions, so all were created through VS Code's Copilot CLI integration |
| Survey run time | 0.7 s |

### Directory layout and locks

| Entry | Count | Notes |
|---|---|---|
| `events.jsonl` | 24 | Append-only event log |
| `workspace.yaml` | 24 | Session metadata (keys below) |
| `checkpoints/`, `files/`, `research/` | 24 each | Not needed for indexing |
| `session.db` | 1 | Per-session SQLite (todos); not needed |
| `<uuid>.lock` | 127 | Many per session |
| `.workspace-fork.lock` | 24 | |
| `inuse.<pid>.lock` + `inuse.<pid>.hold` | 3 + 3 | Session open in a live process; read anyway (R3.5) |

`workspace.yaml` keys: `id`, `cwd`, `git_root` (22/24), `branch` (22/24), `repository` (3/24), `host_type` (3/24, `github`), `client_name`, `name`, `user_named`, `summary_count`, `fork_count`, `created_at`, `updated_at`.

### Event types (top, by count)

| Type | Count | Relevance |
|---|---|---|
| `hook.start` / `hook.end` | 2 837 / 2 837 | ignore |
| `tool.execution_start` / `_complete` | 1 350 / 1 349 | tool calls, files |
| `permission.requested` / `.completed` | 1 148 / 1 148 | ignore (largest by bytes: 13.7 MB, lines up to 350 KB) |
| `assistant.turn_start` / `turn_end` | 980 / 979 | turn end time |
| `assistant.message` | 980 | response, model, thinking |
| `session.usage_record` | 980 | tokens, credits per API call |
| `user.message` | 115 | turn boundary, prompt, attachments |
| `session.usage_checkpoint` | 113 | cumulative totals (ignore) |
| `session.model_change` | 78 | current model |
| `model.*` (8 types) | 73 each | auxiliary nano-model calls (`gpt-5.4-nano`), **not** part of the conversation; ignore |
| `external_tool.requested/completed` | 55 / 55 | duplicates `tool.execution_*`; ignore |
| `subagent.*` | 1–50 | sub-agent lifecycle |
| `session.shutdown` | 31 | session totals (several per session after resume) |
| `system.message` | 27 | system prompt; never index |
| `session.start` / `session.resume` | 24 / 9 | session id, start time, model, context |
| `session.binary_asset` | 14 | base64 image bytes in `data.data`; skip before `JSON.parse` |
| `abort`, `session.mode_changed`, `session.title_changed` | 0 | in public schema; `title_changed` is ephemeral (never persisted) |

Every event has `type`, `data`, `id`, `timestamp` (ISO 8601) and `parentId`. Events from a sub-agent also carry a top-level `agentId` (1 128 events, including 1 `user.message` that is an inter-agent prompt).

### Field mapping (CLI → Searchie model)

The turn boundary is a **root** `user.message`, meaning one without a top-level `agentId`. All events up to the next root `user.message` belong to that turn.

| Model field | CLI source | Notes |
|---|---|---|
| `SessionMeta.id` | `session.start.data.sessionId` → else directory name | Equal in 24/24 |
| `source` | constant `copilot-cli` | |
| `workspaceId` / `workspaceUri` | `workspace.yaml` `git_root` → else `cwd` (as `file://` URI) | See Q3. `session.start.data.context` has the same fields; `session.resume.data.context` can change them |
| `workspaceName` | `repository` (`owner/name`) → else basename(`git_root` ?? `cwd`) | |
| `title` | `workspace.yaml` `name` (auto-summary unless `user_named: true`) → else first meaningful prompt | `session.title_changed` is ephemeral and never in the log |
| `createdAt` | `session.start.data.startTime` → else `workspace.yaml` `created_at` | |
| `lastActivityAt` | last event `timestamp` → else `workspace.yaml` `updated_at` | |
| `sizeBytes` | `events.jsonl` size | |
| `Turn.timestamp` | root `user.message.timestamp` | |
| `Turn.prompt` | `user.message.data.content` | **Not** `transformedContent` (model-facing XML wrapper) |
| `Turn.response` | concatenated `assistant.message.data.content` of root-agent messages (no `agentId`, no `data.parentToolCallId`) | Sub-agent output is excluded from the response |
| `Turn.thinking` | `assistant.message.data.reasoningText` | Not indexed by default (Q2); ignore `reasoningOpaque`, `encryptedContent`, `reasoningBlocks` |
| `Turn.toolCalls` | `tool.execution_start.data.toolName` (+ `mcpServerName`/`mcpToolName`) + compact `data.arguments` (`path`, `paths`, `command`, `pattern`, `query`, `url`, `skill`; ≤ 2 KB) | Includes sub-agent tool calls. Never `tool.execution_complete.data.result.*` (R4.9). Skip `report_intent` (meta) |
| `Turn.files` | `user.message.data.attachments[].path` / `.filePath` (types `file`, `selection`) + `tool.execution_complete.data.fileEdits[].path` (`create`/`edit`/`delete`) + `arguments.path` of `view`/`edit`/`create`/`grep`/`glob` | Never `attachments[].text` / `.data` (R4.8) |
| `Turn.model` | most frequent `assistant.message.data.model` in the turn → else current model (`session.start.data.selectedModel`, updated by `session.model_change.data.newModel`) | |
| `Turn.mode` | `user.message.data.agentMode` (`interactive` \| `plan` \| `autopilot` \| `shell`) → else last `session.mode_changed.data.newMode` → else `interactive` | Absent in all observed messages; Searchie prototype's default `agent` is wrong for the CLI |
| `Turn.promptTokens` | Σ `session.usage_record.data.usage.inputTokens` within the turn | Includes sub-agent calls (`initiator: sub-agent`) |
| `Turn.completionTokens` | Σ `session.usage_record.data.usage.outputTokens` within the turn | `assistant.message.data.outputTokens` is optional and absent in all observed data |
| `Turn.credits` | Σ `usage.copilotUsage.totalNanoAiu` / 1e9 within the turn | The SDK schema says "Divide totalNanoAiu by 1,000,000,000 for AI credits". Use only when `aiCreditsStatus = complete`; otherwise leave it undefined |
| `Turn.elapsedMs` | last `assistant.turn_end` (root) `timestamp` − `user.message.timestamp` | |
| `Turn.canceled` | an `abort` event inside the turn (`data.reason`: `user_initiated`, `remote_command`, `user_abort`, `autopilot_credit_limit`) | 0 observed; taken from the schema |
| `Turn.hidden` | `user.message.data.source` set (e.g. `skill-*`, `agent-*`) **or** `data.isAutopilotContinuation = true` | `source` set on 1/115 messages |
| `Turn.noise` | `isNoise(prompt)` as for VS Code | |
| CLI version (diagnostics) | `session.start.data.copilotVersion` | |

Ignored for indexing: `hook.*`, `permission.*`, `external_tool.*`, `model.*`, `session.usage_checkpoint`, `session.shutdown`, `system.message`, `session.binary_asset`, `assistant.turn_start`, `subagent.*`.

### Differences from Searchie prototype `parser-vscode-cli.ts`

| Searchie prototype behaviour | Observed / schema | Searchie decision |
|---|---|---|
| Every `user.message` starts a turn | Sub-agent prompts are `user.message` events with `agentId` | Only root `user.message` events start turns |
| Response includes all `assistant.message` content | Sub-agent messages have `agentId` / `parentToolCallId` | Root agent only |
| Tokens from `assistant.message.outputTokens` | Field absent; tokens are in `session.usage_record.data.usage` | Use `usage_record` (input and output) |
| No credits | `usage.copilotUsage.totalNanoAiu` per call | credits = nanoAiu / 1e9 |
| `agentMode` default `agent` | Values are `interactive`/`plan`/`autopilot`/`shell` | Default `interactive` |
| Edit-tool code appended to the response text | n/a | Do **not** append; response = assistant text only |
| Files from tool args only | `tool.execution_complete.data.fileEdits[]` exists | Add `fileEdits[].path` |
| Session model usage from `session.shutdown.modelMetrics` | Several shutdowns per session after resume | Sum `usage_record` instead |
| Title not handled | `workspace.yaml` `name` | Use it |

### Parser performance notes

- Top-level `type` is always the first key, so a cheap prefix check (`/^\{"type":"([^"]+)"/`) can skip ignored event types **before** `JSON.parse`. Ignored types make up most of the bytes: `permission.requested` alone is 13.7 of 42 MB.
- `session.binary_asset` lines and `attachments[].data` (blob type) hold base64 image bytes. Skip the line or apply `stripImageData`.

## Resume command (R8.5)

| Form | Source | Use |
|---|---|---|
| `copilot --resume=<sessionId>` | CLI reference: "`-r`, `--resume[=VALUE]` … Optionally specify a session ID, ID prefix, or session name". The `-p` exit summary prints a `copilot --resume=SESSION-ID` hint | **Copy resume command** (R8.5). Use the `=` form because the value is optional and a space-separated id could be misread |
| `copilot --session-id <sessionId>` | CLI reference: "Use an exact session or task ID when you do not want `--resume`'s broader matching" | Alternative for exact matching. Not used, because it creates a new session if the UUID does not exist |

The resumed session runs in its own working directory: the reference describes "the session working directory (the `--resume`, `--worktree`, or `-C` directory)". No `cd` prefix is needed.

## Q3 – Group CLI sessions by repository or by cwd?

**Recommendation: group by folder, using `git_root` and falling back to `cwd`. Use `repository` only as the display label when present.**

- `repository` is present in only 3/24 sessions (GitHub remotes only), so it can't be the primary key.
- `cwd == git_root` in 22/24 sessions; the other 2 are outside git. Grouping by `git_root` also merges sessions started from sub-folders of one repo.
- All sessions come from `vscode-agent-host`, so their folder matches a VS Code workspace folder. A folder key lets the Sessions tree show VS Code and CLI sessions of the same project together. Implementation: workspace key = normalized `file://` URI of `git_root ?? cwd`, with `source` kept as a session attribute.

## Decision

- SPEC §4.3 gets the mapping table above, and R4.12 is resolved.
- Resume command: `copilot --resume=<sessionId>`.
- Q3: group by `git_root ?? cwd`, labelled by `repository` when available.

## Fallbacks

- If `session.usage_record` disappears (it's an internal persisted form of the ephemeral `assistant.usage`), fall back to `assistant.message.data.outputTokens` and `session.shutdown.modelMetrics` for the session totals, and mark per-turn tokens as missing (`—`).
- If `workspace.yaml` is missing (seen in the 2 lock-only directories), skip the directory when it has no `events.jsonl`; otherwise take the workspace from `session.start.data.context`.

## Open risks

- **Format churn.** All local data comes from pre-release builds (1.0.95–1.0.103), and the CLI ships new event types frequently (over 150 in the schema). Mitigation: lenient zod, skip unknown types, and count them in diagnostics (R4.4).
- **No local data for `abort`, `session.mode_changed`, `plan`/`autopilot` modes, or `steering`/`queued` delivery.** Their mapping is based on the public schema only; fixtures cover them synthetically.
- **The `vscode-agent-host` origin.** Followed up in S1: `vscode.open` on `copilotcli:/<sessionId>` opens a CLI session with its history in VS Code 1.145.2, while `agent-host-copilotcli:/<id>` fails. This could extend R8.5 beyond Preview-only (owner decision).

## Reproduce

The survey script was removed once the CLI parser landed (`src/core/parser-cli.ts`). Restore it from the git history (`git log --diff-filter=D -- spikes/s3-cli-mapping/survey.mjs`), then:

```sh
cd spikes/s3-cli-mapping
../node.sh survey.mjs > out/survey.json   # optional arg: alternative session-state root
```

`../node.sh` runs VS Code's bundled Node (`ELECTRON_RUN_AS_NODE=1`). Set `SEARCHIE_NODE` to use a standalone Node ≥ 22. The output (`out/`) is git-ignored. It contains only structure, but review it before you share it.
