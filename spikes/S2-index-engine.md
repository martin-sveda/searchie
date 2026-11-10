# S2 – Index engine: FTS5, persist cost, memory

Status: ✅ **GO with `node:sqlite`.** Stock `sql.js` fails R5.1(a) because it has no FTS5. The R5.2 fallback `node:sqlite` meets N2, N3, N4, N6 and N7. Final confirmation inside the real extension host is part of S1.

> **Decision status:** proposed, pending owner approval (spike rule 5).

## Question

Does the shipped `sql.js` have FTS5 and `fts5vocab` for the exact §5.3 schema? What do cold build, persist, memory, index size and search latency look like for the full local dataset and at 50 000 turns (N2, N3, N4, N6, N7)? If `sql.js` fails, which fallback engine should be used?

## Method

1. **Capability probe** ([`probe-fts5.mjs`](s2-index-engine/probe-fts5.mjs)): creates the exact §5.3 schema ([`schema.mjs`](s2-index-engine/schema.mjs)) and checks diacritics folding, `tokenchars '_'`, prefix, `bm25()` with the §6.3 weights, `snippet()`, and `fts5vocab`.
2. **Engines.** Both sit behind a tiny `IndexStore`-shaped wrapper ([`stores.mjs`](s2-index-engine/stores.mjs)) with `exec/run/all/begin/commit/persist/close`.
   - `sql.js` 1.15.2 (npm `latest`) failed step 1, so it was not benchmarked.
   - `node:sqlite` inside VS Code 1.145.2's runtime (Node 24.22.1, Electron 43.8.3, SQLite 3.53.4). It is file-backed with WAL.
   - `@sqlite.org/sqlite-wasm` 3.54.1 (official build, FTS5 on by default). It holds the DB in memory and persists it by whole-DB export, which is the same model as `sql.js`. It was the like-for-like WASM comparison, approved by the owner.
   - `wa-sqlite` was not needed (R5.2: only if both others fail).
   - Packages were fetched from registry.npmjs.org with the `sha512` integrity checked, because there is no standalone npm on the machine.
3. **Dataset.** VS Code Stable (`workspaceStorage` plus empty-window) and Copilot CLI sessions were **copied** to `/tmp/searchie-spike/data/` (R3.4), 510 MB in total. The sources were never opened for writing.
4. **Pipeline** ([`bench-worker.mjs`](s2-index-engine/bench-worker.mjs)), running in a `worker_thread`:
   - discovery ([`discover.mjs`](s2-index-engine/discover.mjs));
   - stream replay ([`vendor/replay.mjs`](s2-index-engine/vendor/replay.mjs), adapted from Searchie prototype `forEachJsonlLineAsync` / `reconstructFromJsonl` / `stripImageData`);
   - mapping to turns per §4.2 and the S3 CLI table ([`map.mjs`](s2-index-engine/map.mjs)), including noise flags, identifier split into `aux`, path expansion and 64 KB field caps;
   - insert into the full §5.3 schema in batches of 250 sessions per transaction, then FTS `optimize`, persist, an incremental update of one session, the search benchmark, and a reopen of the persisted file.
5. **Synthetic scale-up.** Local data has 739 unique turns, which is under 50 000. Real turns are duplicated with word order shuffled per field (so the vocabulary and term frequency are kept) into synthetic sessions with real-like sizes, spread over 365 days and 40 workspaces, until there are 50 000 turns.
6. **Search** (N4). There are 24 queries, each run 20 times after one warm-up, and the p95 is taken over all 480 runs.
   - Query types: single term (high, mid and low frequency), AND (2 and 3 terms), phrase, prefix (3, 4 and 5 characters), OR, NOT, a column filter, and four filter joins (model + date, workspace, tool via `turn_tools`, mode + date).
   - Terms are picked from `turn_vocab` by document-frequency percentile, and phrases from adjacent prompt words. **Terms are never printed.**
   - Each query uses §6.3 ranking: `bm25` weights 5/4/1/1.5/2/0.5 × recency × noise in a `MATERIALIZED` CTE (FTS5 refuses `bm25()` inside an aggregate), grouping per session with `max + 0.25·ln k`, the top 50 sessions, and the top 3 turns each with `snippet()` on prompt and response.
7. **Memory.** The main thread samples process RSS and the worker heap (`worker.getHeapStatistics()`) every 25 ms. Each configuration runs in its **own process** ([`run-all.sh`](s2-index-engine/run-all.sh)).
8. Hardware: Apple Silicon (arm64), macOS, SSD.

## Results

### Capability probe

| Check | sql.js 1.15.2 (SQLite 3.54.0) | node:sqlite (SQLite 3.53.4) | sqlite-wasm 3.54.1 |
|---|---|---|---|
| Compile options | `ENABLE_FTS3` only | `ENABLE_FTS3 ENABLE_FTS5` | `ENABLE_FTS5 ENABLE_MATH_FUNCTIONS` |
| §5.3 schema incl. `turn_fts`, `turn_vocab` | ❌ `no such module: fts5` | ✅ | ✅ |
| `remove_diacritics 2` (`Členů` ↔ `clenu`) | — | ✅ | ✅ |
| `tokenchars '_'`, prefix `refact*`, bm25 + `snippet()` | — | ✅ | ✅ |
| `exp()` / `ln()` for §6.3 | — | ✅ | ✅ |
| `dbstat` | — | ✅ | — |

### Dataset

| | Value |
|---|---|
| Files | 247 VS Code `.jsonl` (incl. 3 empty-window), 0 legacy `.json`, 24 CLI `events.jsonl` |
| Source size | 510 MB (467 MB VS Code + 43 MB CLI); the largest single file is 184 MB, with lines up to 32 MB |
| Sessions with ≥ 1 turn | 140 unique (116 VS Code + 24 CLI); 83 files are empty |
| Turns | 739 unique (625 VS Code + 114 CLI) |
| Indexed text | 4.5 MB (0.9 % of source; the source is dominated by tool output, which is not indexed) |
| Duplicate session ids | **48 files (24 ids × 2 extra copies)**. See *Findings* |

### N-targets: `node:sqlite` (chosen), worker old-generation heap capped at 256 MB

| Metric | Target | Real data (739 turns, 510 MB) | Synthetic (50 000 turns) | Pass |
|---|---|---|---|---|
| **N2** cold build per 500 MB source | ≤ 90 s | **1.1 s** (parse 0.9 s + insert 0.1 s) | insert 13.2 s for 50k turns; parse is linear in source bytes | ✅ |
| **N6** peak RSS (whole process; baseline 61 MB) | < 600 MB | **373 MB** (worker JS heap 247 MB) | **361 MB** (worker JS heap 247 MB) | ✅ |
| Persist / atomic write | — | WAL checkpoint 0 ms; checkpoint + fsync + copy + rename 15 ms | 2 ms / 383 ms (the copy is a spike artefact; the product builds into a temp file and renames it) | — |
| **N7** index size vs source | ≤ 40 % | **13.9 MB = 2.7 %** | 648.5 MB = 1.9 % of the equivalent source (2.1× the indexed text) | ✅ |
| **N3** incremental update, 1 session | < 1 s | 6 ms (51 turns) | 10 ms (51 turns); WAL commit is durable, so no export is needed | ✅ |
| **N4** search p95, top 50 | < 100 ms @ 50k | 5.9 ms | **44.0 ms** (p50 8.4, max 92.5) | ✅ |
| Reopen persisted index | — | 1 ms | 1 ms | — |

Without the heap cap, V8 grows the worker heap lazily. Peak RSS was then 557 MB (real) and 568–625 MB (synthetic): N6 is borderline and fails in one run. With a 128 MB cap the real build still completes, at 290 MB RSS and with no slowdown. So the cap bounds memory without costing throughput.

### Comparison: `@sqlite.org/sqlite-wasm` (in-memory + export), no cap

| Metric | Target | Real data | Synthetic 50k | Pass |
|---|---|---|---|---|
| N2 | ≤ 90 s | 1.1 s | insert 14.7 s / 50k turns | ✅ |
| N6 peak RSS | < 600 MB | 574 MB (WASM heap 14 MB) | **4 339 MB** (WASM heap 730 MB) | ❌ |
| Persist: `export()` / atomic write | — | 2 ms / 13 ms | 80 ms / 94 ms (whole DB, after **every** batch) | — |
| N7 | ≤ 40 % | 2.8 % | 1.9 % | ✅ |
| N3 incremental (tx + export + write) | < 1 s | 21 ms | 192 ms | ✅ |
| N4 search p95 | < 100 ms | 8.1 ms | 58.7 ms (max 122) | ✅ |
| Reopen (read file + `sqlite3_deserialize`) | — | 7 ms | 188 ms | — |

### Search latency by query type: `node:sqlite`, 50 000 turns

| Query type | Queries | Matched turns (avg) | p50 ms | p95 ms |
|---|---|---|---|---|
| single term, high frequency | 2 | 16 191 | 24.9 | 43.1 |
| single term, mid | 2 | 1 558 | 5.7 | 10.6 |
| single term, low | 1 | 150 | 3.1 | 3.2 |
| AND (2 terms) | 3 | 1 152 | 4.7 | 8.0 |
| AND (3 terms) | 1 | 197 | 1.9 | 2.2 |
| phrase | 3 | 345 | 3.5 | 13.2 |
| prefix (3/4/5 chars) | 3 | 18 767 | 31.0 | 91.8 |
| OR | 3 | 12 124 | 14.1 | 44.1 |
| NOT | 1 | 9 132 | 21.9 | 22.5 |
| column (`{prompt}:`) | 1 | 551 | 2.5 | 2.6 |
| filter: model + date | 1 | 212 | 7.4 | 7.5 |
| filter: workspace | 1 | 113 | 6.1 | 6.2 |
| filter: tool (`turn_tools`) | 1 | 2 999 | 23.4 | 23.5 |
| filter: mode + date | 1 | 174 | 4.2 | 4.5 |

### Index composition at 50 000 turns (`dbstat`)

| Table | MB | % |
|---|---|---|
| `turn_text` (FTS external content, needed for `snippet()`) | 346.0 | 54.0 |
| `turn_fts_data` (inverted index + prefix indexes) | 281.6 | 43.9 |
| everything else | 12.9 | 2.1 |

`prefix='2 3'` trade-off (schema variant without it, 50k turns): the index shrinks from 649 MB to 487 MB (−25 %) and inserts take 8.0 s instead of 13.2 s. However, the broadest 3-character prefix query, which matches 42k of 50k turns, gets slower: p95 rises from 92 to 140 ms. **Keep `prefix='2 3'`**.

## Findings that affect the spec

1. **`sql.js` has no FTS5.** A custom build would need emsdk (about 1 GB toolchain) and a rebuild for every sql.js or SQLite release. It also inherits the in-memory and whole-export cost measured for sqlite-wasm above (4.3 GB RSS at 50k turns). It is not worth doing.
2. **Prune on replay is required for N6.** Of the 184 MB file, 150 MB is `toolInvocationSerialized` payload (`resultDetails`, `toolSpecificData`) and 33 MB is `result.metadata`, none of which is indexed. Replaying it as-is retains 184 MB of JS heap. The spike drops those fields right after each line's `JSON.parse` and strips them at string level for lines over 256 KB. That cut peak RSS from 752 to 469 MB without the cap.
3. **`sessionId` is not unique across `workspaceStorage`.** 24 sessions exist as byte-identical copies in three workspace folders: one folder workspace and two `.code-workspace` URIs. The copies were most likely made when VS Code copied the storage over. §5.3 `sessions.id TEXT PRIMARY KEY` would collide, and the spike's first run left orphan turns. Proposed fix for Phase 1: dedupe by `(source, sessionId)` and keep the copy with the newest mtime (ties go to the first). Record the alternate workspaces, so that *Open in Chat* (R8.1) also works from them. This changes §5.3 and §7.1 and **has not been applied to SPEC.md**; it needs an owner decision.
4. **Field mapping corrections (§4.2), observed on VS Code 1.145.2 data:**
   - there is no `isCanceled`; cancellation is `modelState.value === 2`;
   - `isSystemInitiated` exists and should count as hidden;
   - `thinking.value` may be a string or an array;
   - all sessions are `version: 3`.

## Decision (proposed)

**Engine: built-in `node:sqlite`, file-backed (WAL), in a `worker_thread` with `resourceLimits.maxOldGenerationSizeMb = 256`.**

- It's the only option that meets N6 at 50k turns with headroom (361 MB). It is also faster at search (p95 44 ms vs 59 ms) and at reopening (1 ms vs 188 ms).
- Persistence is a durable WAL commit (N3 = 10 ms), with no whole-DB export. A cold build or rebuild writes `index.sqlite.build` and renames it over the old file, which makes R5.4 atomic.
- Multi-window (R5.3): readers open the same file with `readOnly: true` and see committed data through WAL, so there's no reload-on-change. The single-writer lock stays.
- It adds zero npm dependencies and no `.wasm` asset, which simplifies the esbuild step in §13.

## Fallbacks

1. `@sqlite.org/sqlite-wasm` (works, but N6 fails beyond about 10k turns) is acceptable only for small histories, or if `node:sqlite` disappears from VS Code's runtime.
2. `wa-sqlite` with a file-backed VFS (R5.2) is the next step if the in-memory model must be avoided without `node:sqlite`.
3. A custom `sql.js` build is not recommended (see *Findings* 1).

## Open risks

- **`node:sqlite` stability.** It has been unflagged since Node 22.13 and is a release candidate (stability 1.2) since Node 24.15. The API may still change. Mitigations: the `IndexStore` interface, and a smoke test on the minimum supported VS Code. The minimum VS Code version whose Electron ships Node ≥ 22.13 is resolved in S1 (N9).
- **Extension host.** This spike ran in VS Code's Electron binary with `ELECTRON_RUN_AS_NODE=1`, not in the extension host itself. The S1 probe confirms `require('node:sqlite')` there.
- **Worst-case queries.** Very broad prefixes such as 3 characters matching 85 % of turns reach p95 92 ms at 50k turns. Mitigations: debounce and cancel (R6.12), and only prefix-expand queries of ≥ 3 characters.
- **Synthetic realism.** Shuffled real text keeps the term distribution but not phrase structure, so phrase hit rates are lower than with real text. The "equivalent source" for 50k turns (34.5 GB) is extrapolated from the local average of 0.69 MB per turn.

## Reproduce

```sh
cd spikes/s2-index-engine
# 1. Dependencies (no npm on this machine; with npm: npm i sql.js@1.15.2 @sqlite.org/sqlite-wasm@3.54.1-build1)
# 2. Copy a stable dataset (sources stay untouched):
S="$HOME/Library/Application Support/Code/User"; D=/tmp/searchie-spike/data
rsync -a --include='*/' --include='workspace.json' --include='chatSessions/*.jsonl' --include='chatSessions/*.json' \
  --exclude='*' --prune-empty-dirs "$S/workspaceStorage" $D/vscode/
mkdir -p $D/vscode/globalStorage && rsync -a "$S/globalStorage/emptyWindowChatSessions" $D/vscode/globalStorage/
rsync -a --include='*/' --include='events.jsonl' --include='workspace.yaml' --exclude='*' --prune-empty-dirs ~/.copilot/session-state/ $D/cli/
# 3. Run
../node.sh probe-fts5.mjs          # capability table
./run-all.sh > out/report.md       # all configurations, each in its own process (~2 min)
```

`out/` holds results with counts and timings only, and it is git-ignored. Index files are written to `/tmp/searchie-spike/index/` (mode `0600`). Delete them after the run because they contain session text.
