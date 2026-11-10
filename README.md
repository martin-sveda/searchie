# Searchie

Full-text search across your local **GitHub Copilot chat sessions** in VS Code: prompts, responses, tool calls and referenced files, across all workspaces, ranked by relevance. Built-in chat history only searches titles.

- **Search Sessions** (`⌘⌥⇧F` / `Ctrl+Alt+Shift+F`): live, ranked results with snippets.
- **Sessions view** in the Activity Bar: sessions grouped by workspace and date, with per-session statistics in the tooltip.
- **Preview** a session read-only, or **Open in Chat** when it belongs to the current workspace.
- 100 % local, read-only on your chat data, no telemetry, no network access.

Sources in this version: VS Code Stable, VS Code Insiders and empty-window sessions. Copilot CLI sessions are planned.

## Query syntax

| Syntax | Meaning | Example |
|---|---|---|
| `word word` | all terms | `sql fts5` |
| `"…"` | phrase | `"open session"` |
| `a OR b` | either | `jest OR vitest` |
| `-word` | exclude | `deploy -azure` |
| `word*` | prefix (≥ 2 characters) | `refact*` |
| `ws:` `model:` `mode:` `tool:` `file:` | workspace name, model, mode, tool, referenced file contains | `ws:searchie tool:run_in_terminal` |
| `src:` | source: `vscode`, `insiders` | `src:insiders` |
| `in:` | restrict to columns: `title`, `prompt`, `response`, `tools`, `files` | `in:prompt,response` |
| `after:` `before:` | `YYYY-MM-DD` or relative `7d`, `2w`, `3m`, `1y` | `after:30d` |

Matching ignores case and diacritics (`clenu` finds `členů`), splits identifiers (`parse json` finds `parseJsonLine`) and file paths (`parser` finds `src/parser-vscode.ts`). Trivial prompts such as `continue` or `yes` rank lower.

While you type, VS Code moves sessions whose *title* matches the typed text to the top of the Quick Pick (the stable API can't turn label sorting off); everything else keeps Searchie's ranking.

## Opening sessions

- **Same workspace:** *Open in Chat* (Enter in Quick Pick, 💬 in the Sessions view) loads the session into the **Chat view**, where you can continue it (`searchie.open.chatLocation`: `view` or `editor`).
- **Other workspace:** choose *Open Read-only Preview* or *Open Workspace in New Window*; the new window loads the session into its Chat view. `searchie.open.otherWorkspaceDefault` skips the question.
- **Empty-window sessions** open in a new empty window. **Insiders ↔ Stable** sessions open as a Preview only.
- **Preview** (👁): the conversation with collapsed *Thinking*, tool calls without output, referenced files (struck through when they don't exist on this machine), your search terms highlighted (↑/↓ to jump), ⌘F/Ctrl+F find, and a *Show secrets* toggle.

## Privacy

- Searchie only **reads** VS Code's chat session files. It never writes, moves or locks them.
- **The index contains a copy of your chat content** (prompts, responses, tool calls and file paths; not attachment content and not tool output). It is stored in Searchie's global storage folder (`…/User/globalStorage/searchie.searchie/`) with file mode `0600`.
- Run **Searchie: Delete Index** to remove it. Indexing then stays paused until you run *Refresh Index* or *Rebuild Index*.
- Secrets (tokens, keys, passwords) stay searchable for you but are redacted in snippets and previews (`searchie.redactSecrets`).
- No telemetry and no network access. The log (*Searchie: Show Log*) contains counts, timings and session ids only, never chat text.

## Settings

| Setting | Default | Description |
|---|---|---|
| `searchie.sources.vscode` / `.vscodeInsiders` / `.emptyWindow` | `true` | Which sessions to index |
| `searchie.additionalSessionRoots` | `[]` | Extra VS Code `User/` directories (WSL, dev containers, remote homes); a path containing `insiders` counts as Insiders |
| `searchie.excludeWorkspaces` | `[]` | Glob patterns on the workspace folder path, e.g. `**/scratch/**` |
| `searchie.index.includeThinking` | `false` | Also index model thinking text (never shown in snippets) |
| `searchie.index.maxTurnTextKB` | `64` | Indexed text per field per turn |
| `searchie.index.pollIntervalMinutes` | `5` | Fallback poll; `0` = off |
| `searchie.noisePatterns` | `[]` | Extra trivial-prompt regexes, e.g. `pokračuj` |
| `searchie.search.defaultScope` | `all` | `all` or `currentWorkspace` |
| `searchie.search.recencyBoost` | `0.2` | Boost for recent turns |
| `searchie.search.maxResults` | `50` | Sessions per page |
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
npm run bench -- --data <VS Code User dir> [--synthetic 50000]   # N2/N3/N4/N6/N7; copy real data to /tmp/searchie-dev first
npm run package     # VSIX in dist-vsix/
```

- **Fixtures.** `src/test/fixtures/` holds anonymized sessions (see its README). For the Extension Development Host, set `searchie.additionalSessionRoots` to `<repo>/src/test/fixtures/vscode` and turn `searchie.sources.vscode` off.
- **Same-workspace Open in Chat** can't be tested in the Extension Development Host, which uses its own `workspaceStorage/ext-dev`. Build a VSIX (`npm run package`), install it with `code --install-extension dist-vsix/searchie-0.1.0.vsix`, test in a real window, then uninstall it.
- Architecture, requirements and decisions: [SPEC.md](SPEC.md). Third-party code: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

MIT. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
