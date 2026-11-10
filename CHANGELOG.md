# Changelog

## 0.1.0 – Phase 1 MVP

First internal version. VS Code ≥ 1.106; local only, read-only on chat data, no telemetry.

### Added

- **Indexing** of VS Code Stable, Insiders and empty-window Copilot chat sessions (`.jsonl` mutation logs and legacy `.json`) into a local SQLite FTS5 index (built-in `node:sqlite`, WAL) in a worker thread with a 256 MB heap cap. Includes prune-on-replay, a 64 MB line cap, incremental updates via workspace fingerprints and file watchers, a single writer across windows, deduplication of copied sessions, and automatic rebuild on schema, parser or index-setting changes.
- **Search Sessions** Quick Pick (`⌘⌥⇧F` / `Ctrl+Alt+Shift+F`): ranked results (bm25 with field weights, recency boost, noise penalty) with snippets, paging and query syntax (`"phrase"`, `OR`, `-exclude`, `prefix*`, `ws:`, `src:`, `model:`, `mode:`, `tool:`, `file:`, `in:`, `after:`, `before:`). Matching ignores case and diacritics, splits identifiers and expands file paths.
- **Sessions view**: grouped by workspace and date (or date → workspace, or flat), filter by source, model, mode and date, sort, per-session statistics in the tooltip, summary line, and index status.
- **Preview**: read-only rendering of a session with markdown, collapsed thinking, tool chips, file links, term highlighting, find, and secret redaction with a *Show secrets* toggle.
- **Open in Chat** for sessions of the current workspace, shown in the Chat view (`searchie.open.chatLocation`); other workspaces open as a Preview or in a new window that continues the session there; empty-window and Insiders/Stable handling.
- Commands: Refresh, Rebuild and Delete Index, Copy Session ID, Reveal Session File, Search in this Session/Workspace, Show Log. Status bar item.
- `npm run bench` for the SPEC §11 performance targets; smoke tests on VS Code 1.106 and Stable.
