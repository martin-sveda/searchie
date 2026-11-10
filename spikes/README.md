# Phase 0 – Spikes: go/no-go

Phase 0 ran on 2026-11-10 against VS Code 1.145.2 (Electron 43.8.3, Node 24.22.1) on macOS arm64. The spike code is throwaway; product code starts in Phase 1.

| Spike | Status | Decision | Impact on SPEC |
|---|---|---|---|
| [S1 Open in Chat](S1-open-in-chat.md) | ✅ GO | `vscode.open` on `vscode-chat-session://local/<base64url(id)>` opens a same-workspace session as a chat editor (owner-verified). Fallback 1: `workbench.action.chat.openSessionInEditorGroup { resource }`. Fallback 2: Preview, with an optional `pickAgentSession` picker (weak). Bonus: `copilotcli:/<id>` opens CLI sessions | R8.1 confirmed and ordered; N9/Q4: **VS Code ≥ 1.106** |
| [S2 Index engine](S2-index-engine.md) | ✅ GO (engine switch) | Stock `sql.js` has **no FTS5** ❌. **`node:sqlite`** (file-backed, WAL, worker heap cap 256 MB) meets N2/N3/N4/N6/N7. At 50k turns: p95 44 ms, 361 MB RSS, 10 ms incremental. sqlite-wasm fails N6 (4.3 GB) | §5.1 engine = `node:sqlite`; prune-on-replay required for N6 |
| [S3 Copilot CLI](S3-copilot-cli.md) | ✅ GO | Root-`user.message` turn model; tokens and credits from `session.usage_record`; sub-agent events excluded; resume command `copilot --resume=<sessionId>` | §4.3 mapping table, R4.12 resolved; Q3: group by `git_root ?? cwd` |

## Follow-ups for Phase 1 (not yet in SPEC; need an owner decision)

1. **Duplicate session ids.** The same `sessionId` can exist in several `workspaceStorage` folders (byte-identical copies). The §5.3 `sessions.id` primary key collides. Proposal: dedupe by `(source, sessionId)` and keep the newest mtime (§5.3, §7.1).
2. **§4.2 corrections.** `isCanceled` doesn't exist; use `modelState.value === 2`. `isSystemInitiated` counts as hidden. `thinking.value` may be a string or an array.
3. **Consistency edits** following the engine switch: the §13 diagram and esbuild note (no `sql-wasm.wasm`), K3, the §2 tooling row, and R5.3 (WAL readers no longer need reload-on-change).
4. **R8.5.** Optionally offer *Open in Chat* for CLI sessions via `copilotcli:/<id>`.
5. **Development.** The Extension Development Host uses its own `workspaceStorage/ext-dev`, so manual same-workspace tests need a VSIX ([`s1-chat-open/make-vsix.sh`](s1-chat-open/make-vsix.sh)).

## Layout

- `node.sh` runs VS Code's bundled Node (`ELECTRON_RUN_AS_NODE=1`), the same runtime as the extension host.
- `s1-chat-open/`: probe extension. `s2-index-engine/`: benchmark. `s3-cli-mapping/`: structure survey.
- `make-fixtures.mjs` generates the anonymized fixtures in [`../src/test/fixtures/`](../src/test/fixtures/README.md).
- `*/out/` holds local results (counts and timings only) and is git-ignored.
