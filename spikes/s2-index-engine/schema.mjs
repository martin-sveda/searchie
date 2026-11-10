// Exact schema from SPEC §5.3.
export const SCHEMA_SQL = `
CREATE TABLE meta      (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE workspaces(id TEXT PRIMARY KEY, source TEXT, name TEXT, uri TEXT);
CREATE TABLE files     (path TEXT PRIMARY KEY, source TEXT, workspace_id TEXT,
                        mtime INTEGER, size INTEGER, parser_version INTEGER,
                        status TEXT, error TEXT);
CREATE TABLE sessions  (id TEXT PRIMARY KEY, file_path TEXT, source TEXT, workspace_id TEXT,
                        title TEXT, created_at INTEGER, last_at INTEGER,
                        turn_count INTEGER, prompt_count INTEGER, noise_count INTEGER,
                        canceled_count INTEGER, tool_call_count INTEGER,
                        prompt_tokens INTEGER, completion_tokens INTEGER,
                        credits REAL, elapsed_ms INTEGER, size_bytes INTEGER,
                        primary_model TEXT, primary_mode TEXT);
CREATE TABLE turns     (id INTEGER PRIMARY KEY, session_id TEXT, idx INTEGER, ts INTEGER,
                        model TEXT, mode TEXT, prompt_tokens INTEGER, completion_tokens INTEGER,
                        credits REAL, elapsed_ms INTEGER, hidden INTEGER, canceled INTEGER, noise INTEGER);
CREATE TABLE turn_tools(turn_id INTEGER, tool TEXT, count INTEGER);
CREATE TABLE turn_text (id INTEGER PRIMARY KEY, title TEXT, prompt TEXT, response TEXT,
                        tools TEXT, files TEXT, aux TEXT);
CREATE VIRTUAL TABLE turn_fts USING fts5(
  title, prompt, response, tools, files, aux,
  content='turn_text', content_rowid='id',
  tokenize="unicode61 remove_diacritics 2 tokenchars '_'",
  prefix='2 3'
);
CREATE VIRTUAL TABLE turn_vocab USING fts5vocab(turn_fts, 'row');
CREATE INDEX ix_sessions_ws  ON sessions(workspace_id, last_at);
CREATE INDEX ix_turns_session ON turns(session_id, idx);
`;
