# Searchie

Full-text search across your local **GitHub Copilot chat sessions**, from VS Code and the Copilot CLI: prompts, responses, tool calls and referenced files, across all workspaces, ranked by relevance. Built-in chat history only searches titles.

- **Search Sessions** (`⌘⌥⇧F` / `Ctrl+Alt+Shift+F`): live, ranked results with snippets.
- **Search Panel**: the same search with filter dropdowns, sorting and paging in an editor tab.
- **Sessions view** in the Activity Bar: sessions grouped by project folder (VS Code and CLI together) and date, with per-session statistics in the tooltip.
- **Statistics**: activity, workspaces, models, modes, tools, an hour × weekday heatmap and top sessions, with CSV export.
- **Preview** a session read-only, or **Open in Chat**.
- 100 % local, read-only on your chat data, no telemetry, no network access.

Sources: VS Code Stable, VS Code Insiders, empty-window sessions and Copilot CLI sessions (`~/.copilot/session-state`).

## Query syntax

| Syntax | Meaning | Example |
|---|---|---|
| `word word` | all terms | `sql fts5` |
| `"…"` | phrase | `"open session"` |
| `a OR b` | either | `jest OR vitest` |
| `-word` | exclude | `deploy -azure` |
| `word*` | prefix (≥ 2 characters) | `refact*` |
| `~word` | fuzzy: also similar words (1–2 typos) | `~migratoin` |
| `ws:` `model:` `mode:` `tool:` `file:` | workspace name, model, mode, tool, referenced file contains | `ws:searchie tool:run_in_terminal` |
| `src:` | source: `vscode`, `insiders`, `cli` | `src:cli` |
| `in:` | restrict to columns: `title`, `prompt`, `response`, `tools`, `files` | `in:prompt,response` |
| `after:` `before:` | `YYYY-MM-DD` or relative `7d`, `2w`, `3m`, `1y` | `after:30d` |

Matching ignores case and diacritics (`clenu` finds `členů`), splits identifiers (`parse json` finds `parseJsonLine`) and file paths (`parser` finds `src/parser-vscode.ts`). Trivial prompts such as `continue` or `yes` rank lower. When nothing matches, Searchie suggests a corrected query (*Did you mean …*); with `searchie.search.autoFuzzy` it also retries searches with fewer than 3 results fuzzily.

While you type, VS Code moves sessions whose *title* matches the typed text to the top of the Quick Pick (the stable API can't turn label sorting off); everything else keeps Searchie's ranking.

## Search Panel

*Searchie: Open Search Panel* (also in the Sessions view title, and the ↗ button in Quick Pick, which carries your query along). The Source, Workspace, Model, Mode and Date dropdowns and the *In* checkboxes edit the filter words in the query box, and typing filters updates the dropdowns. Sort by relevance, newest, oldest, prompts or credits. Keyboard: ↓ from the query box into the results, ↑/↓ to move, Enter to open, Space to preview, ⌘/Ctrl+Enter for a new window. Clicking a `#n You:` line previews the session at that turn. `?` shows the syntax, and the query box remembers your last 20 searches.

## Statistics

*Searchie: Show Statistics* (also in the view title, or click the **Summary** line in the Sessions view). All widgets follow the filter bar (date range, source, workspace, model, mode):

- KPI cards, with token and credit coverage (the share of turns that recorded them; missing data shows as `—`)
- activity per day, week or month by source, with credits
- workspaces, models, modes and agents
- the top 20 tools (click a tool to search for it)
- prompts by local hour and weekday
- top sessions by prompts, credits and duration (click to preview)

Hidden turns are not counted. **Export CSV** on each widget re-runs its query and writes only the file you choose. The CSV is UTF-8 with BOM, and text is redacted when `searchie.redactSecrets` is on. Cells starting with `=`, `+`, `-`, `@` or a tab get a leading `'` so spreadsheets don't run them as formulas.

## Opening sessions

- **Same workspace:** *Open in Chat* (Enter in Quick Pick, 💬 in the Sessions view) loads the session into the **Chat view**, where you can continue it (`searchie.open.chatLocation`: `view` or `editor`).
- **Other workspace:** choose *Open Read-only Preview* or *Open Workspace in New Window*; the new window loads the session into its Chat view. `searchie.open.otherWorkspaceDefault` skips the question.
- **Empty-window sessions** open in a new empty window. **Insiders ↔ Stable** sessions open as a Preview only.
- **Copilot CLI sessions** (terminal icon): *Open in Chat* opens an idle session in a Copilot Chat editor from any window; this needs the GitHub Copilot Chat extension. A session that is in use in a terminal (an `inuse.*.lock` with a running process; from an additional root, any lock) opens as a Preview instead. *Copy Resume Command* copies `copilot --resume=<id>`.
- **Preview** (👁): the conversation with collapsed *Thinking*, tool calls without output, referenced files (struck through when they don't exist on this machine), your search terms highlighted (↑/↓ to jump), ⌘F/Ctrl+F find, and a *Show secrets* toggle.

## Privacy

- Searchie only **reads** VS Code's and the Copilot CLI's chat session files. It never writes, moves or locks them, and it never attaches to a running CLI session.
- **The index contains a copy of your chat content** (prompts, responses, tool calls and file paths; not attachment content, not tool output, and not Copilot CLI sub-agent output, system prompts or images). It is stored in Searchie's global storage folder (`…/User/globalStorage/searchie.searchie/`) with file mode `0600`.
- Run **Searchie: Delete Index** to remove it. Indexing then stays paused until you run *Refresh Index* or *Rebuild Index*.
- Secrets (tokens, keys, passwords) stay searchable for you but are redacted in snippets and previews (`searchie.redactSecrets`).
- No telemetry and no network access; Chart.js is bundled. The log (*Searchie: Show Log*) contains counts, timings and session ids only, never chat text or paths.
- CSV export writes only the file you pick in the save dialog.

## Settings

| Setting | Default | Description |
|---|---|---|
| `searchie.sources.vscode` / `.vscodeInsiders` / `.emptyWindow` / `.copilotCli` | `true` | Which sessions to index |
| `searchie.additionalSessionRoots` | `[]` | Extra session roots (WSL, dev containers, remote homes): VS Code `User/` directories (a path containing `insiders` counts as Insiders) or Copilot CLI roots (`…/session-state`, `…/history-session-state`, or a `.copilot` directory) |
| `searchie.excludeWorkspaces` | `[]` | Glob patterns on the workspace folder path, e.g. `**/scratch/**` |
| `searchie.index.includeThinking` | `false` | Also index model thinking text (never shown in snippets) |
| `searchie.index.maxTurnTextKB` | `64` | Indexed text per field per turn |
| `searchie.index.pollIntervalMinutes` | `5` | Fallback poll; `0` = off |
| `searchie.noisePatterns` | `[]` | Extra trivial-prompt regexes, e.g. `pokračuj` |
| `searchie.search.defaultScope` | `all` | `all` or `currentWorkspace` |
| `searchie.search.recencyBoost` | `0.2` | Boost for recent turns |
| `searchie.search.maxResults` | `50` | Sessions per page |
| `searchie.search.autoFuzzy` | `false` | Retry searches with fewer than 3 results fuzzily |
| `searchie.open.otherWorkspaceDefault` | `ask` | `ask`, `preview` or `newWindow` |
| `searchie.open.chatLocation` | `view` | `view`: continue the session in the Chat side bar; `editor`: open it as a chat editor tab |
| `searchie.tree.groupBy` | `workspaceDate` | `workspaceDate`, `dateWorkspace` or `flat` |
| `searchie.redactSecrets` | `true` | Redact secrets in snippets and previews |

Settings that shape the index are user-level only, because one index is shared by all VS Code windows.

## Development

Requirements: Node ≥ 22.13 with npm (for `node:sqlite`), VS Code ≥ 1.106.

```sh
npm install
npm run lint        # tsc + eslint
npm test            # vitest with coverage (fixtures only)
npm run build       # esbuild bundles into dist/
npm run test:smoke  # VS Code smoke tests (SEARCHIE_VSCODE=installed | stable | 1.106.0)
npm run bench -- --data <dir> [--synthetic 50000]   # N2–N7; <dir> = a VS Code User dir, a CLI root, or a dir with vscode/ and cli/session-state/
npm run package     # VSIX in dist-vsix/
```

- **Fixtures.** `src/test/fixtures/` holds anonymized sessions (see its README). For the Extension Development Host, set `searchie.additionalSessionRoots` to `<repo>/src/test/fixtures/vscode` and `<repo>/src/test/fixtures/cli/session-state`, and turn `searchie.sources.vscode` and `searchie.sources.copilotCli` off.
- **Benchmarks on real data** run on a copy: copy your sessions to `/tmp/searchie-dev/` (`vscode/` with `workspaceStorage/*/chatSessions` and `workspace.json`, and `cli/session-state/*/{events.jsonl,workspace.yaml}`), run the bench, then delete the copy. The output contains counts and timings only.
- **Same-workspace Open in Chat** can't be tested in the Extension Development Host, which uses its own `workspaceStorage/ext-dev`. Build a VSIX (`npm run package`), install it with `code --install-extension dist-vsix/searchie-0.2.0.vsix`, test in a real window, then uninstall it and delete `…/User/globalStorage/searchie.searchie/`.
- **Builds:** every CI run on `master` uploads the VSIX as the artifact `searchie-vsix`. There are no GitHub releases.
- Architecture, requirements and decisions: [SPEC.md](SPEC.md). Third-party code: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

MIT. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
