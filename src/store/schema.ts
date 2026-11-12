/** Index schema (SPEC §5.3) and versions (R4.7, R5.17). */

export const SCHEMA_VERSION = 3;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta      (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY, source TEXT, name TEXT, uri TEXT,
                        fingerprint TEXT, folder TEXT);
CREATE TABLE IF NOT EXISTS files     (path TEXT PRIMARY KEY, source TEXT, workspace_id TEXT,
                        mtime INTEGER, size INTEGER, parser_version INTEGER,
                        session_key TEXT, status TEXT, error TEXT);
CREATE TABLE IF NOT EXISTS sessions  (key TEXT PRIMARY KEY,
                        id TEXT, file_path TEXT, source TEXT, workspace_id TEXT,
                        title TEXT, custom_title INTEGER, created_at INTEGER, last_at INTEGER,
                        turn_count INTEGER, prompt_count INTEGER, noise_count INTEGER,
                        canceled_count INTEGER, tool_call_count INTEGER,
                        prompt_tokens INTEGER, completion_tokens INTEGER,
                        credits REAL, elapsed_ms INTEGER, size_bytes INTEGER,
                        primary_model TEXT, primary_mode TEXT);
CREATE TABLE IF NOT EXISTS turns     (id INTEGER PRIMARY KEY, session_key TEXT, idx INTEGER, ts INTEGER,
                        model TEXT, mode TEXT, prompt_tokens INTEGER, completion_tokens INTEGER,
                        credits REAL, elapsed_ms INTEGER, hidden INTEGER, canceled INTEGER, noise INTEGER,
                        has_prompt INTEGER);
CREATE TABLE IF NOT EXISTS turn_tools(turn_id INTEGER, tool TEXT, count INTEGER);
CREATE TABLE IF NOT EXISTS turn_text (id INTEGER PRIMARY KEY, title TEXT, prompt TEXT, response TEXT,
                        tools TEXT, files TEXT, aux TEXT);
CREATE VIRTUAL TABLE IF NOT EXISTS turn_fts USING fts5(
  title, prompt, response, tools, files, aux,
  content='turn_text', content_rowid='id',
  tokenize="unicode61 remove_diacritics 2 tokenchars '_'",
  prefix='2 3'
);
CREATE VIRTUAL TABLE IF NOT EXISTS turn_vocab USING fts5vocab(turn_fts, 'row');
CREATE INDEX IF NOT EXISTS ix_sessions_ws   ON sessions(workspace_id, last_at);
CREATE INDEX IF NOT EXISTS ix_turns_session ON turns(session_key, idx);
CREATE INDEX IF NOT EXISTS ix_turn_tools    ON turn_tools(turn_id);
CREATE INDEX IF NOT EXISTS ix_files_session ON files(session_key);
CREATE INDEX IF NOT EXISTS ix_files_ws      ON files(workspace_id);
CREATE INDEX IF NOT EXISTS ix_workspaces_folder ON workspaces(folder);
`;

/** FTS column order; used for bm25 weights (§6.3) and snippet() column indexes. */
export const FTS_COLUMNS = ['title', 'prompt', 'response', 'tools', 'files', 'aux'] as const;
export type FtsColumn = (typeof FTS_COLUMNS)[number];

/** Index-shaping settings; a change triggers a rebuild (R5.17). */
export interface IndexConfig {
  includeThinking: boolean;
  maxTurnTextKB: number;
}

export const META = {
  schemaVersion: 'schemaVersion',
  parserVersion: 'parserVersion',
  indexConfig: 'indexConfig',
  noisePatterns: 'noisePatterns',
  builtAt: 'builtAt',
} as const;

export const indexConfigValue = (c: IndexConfig): string => JSON.stringify({ includeThinking: c.includeThinking, maxTurnTextKB: c.maxTurnTextKB });
