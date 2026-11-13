# Changelog

## 0.2.0 – Phase 2 internal release

Distributed as a VSIX only (CI artifact `searchie-vsix` or a local build); no GitHub release. VS Code ≥ 1.106; still local only, read-only on chat data, no telemetry.

### Added

- **Copilot CLI sessions** from `~/.copilot/session-state` (and the legacy `history-session-state`), plus CLI roots in `searchie.additionalSessionRoots` (`…/session-state` or a `.copilot` directory). The parser streams `events.jsonl` and skips ignored event types before parsing. It takes root `user.message` turns only (sub-agent prompts and output are excluded), tokens and credits from `session.usage_record`, and model, mode, canceled and hidden turns. Tool output, binary assets and system prompts are never read into the index. Setting `searchie.sources.copilotCli`.
- **Folder groups**: VS Code and Copilot CLI sessions of the same project folder share one group in the Sessions view, e.g. `searchie (VS Code, Copilot CLI)`. *Search in this Workspace* covers the whole group.
- **Opening CLI sessions**: *Open in Chat* via the Copilot Chat extension when the session is idle; a session in use in a terminal opens as a Preview. *Copy Resume Command* (`copilot --resume=<id>`) is available in the tree, Quick Pick and Preview.
- **Fuzzy search**: `~word` also matches similar words (up to 2 edits). *Did you mean …* appears when a search finds nothing. `searchie.search.autoFuzzy` re-runs searches with fewer than 3 results fuzzily.
- **Search Panel** (*Searchie: Open Search Panel*, the view title, or Quick Pick's ↗ button):
  - Source, Workspace, Model, Mode and Date dropdowns and `in:` checkboxes, kept in sync with the query text.
  - Sort by relevance, newest, oldest, prompts or credits, with paging and keyboard navigation.
  - Preview at the clicked turn, query history (last 20) and syntax help.
- **Statistics** (*Searchie: Show Statistics*, the view title, or a click on the Summary node):
  - KPI cards with token and credit coverage, activity over time by source with credits, workspaces, models, modes and agents, top tools, an hour × weekday heatmap, and top sessions.
  - A filter bar for date, source, workspace, model and mode. Clicks filter, start a `tool:` search, or open a Preview.
  - Charts by Chart.js, bundled locally.
- **CSV export** of each statistics table: UTF-8 with BOM, redacted text, and formula-injection protection. Searchie writes only the file you pick.
- `npm run bench` reports fuzzy queries and the Statistics query time (N5); the smoke tests cover the CLI fixture, the Search Panel and Statistics.

### Changed

- Index schema v3, with a folder key per workspace and a prompt flag per turn. Existing indexes are rebuilt automatically on first start.
- The Quick Pick has an *Open in Search Panel* title button; CLI results offer *Copy Resume Command* instead of *New Window*.

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
