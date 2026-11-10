import { deriveTitle } from '../core/parser-vscode';
import type { ParsedSession, SessionMeta, SourceId, Turn } from '../core/model';
import { capText, expandPaths, identifierParts } from '../core/text';
import type { IndexStore, SqlValue } from './index-store';
import { FTS_COLUMNS, type IndexConfig, indexConfigValue, META, SCHEMA_SQL, SCHEMA_VERSION } from './schema';

/** Typed access to the index tables. All SQL uses bound parameters (R6.1, R10.6). */

export interface WorkspaceRow {
  id: string;
  source: string;
  name: string;
  uri: string | null;
  fingerprint: string | null;
}

export type FileStatus = 'ok' | 'empty' | 'duplicate' | 'failed';

export interface FileRow {
  path: string;
  source: string;
  workspace_id: string;
  mtime: number;
  size: number;
  parser_version: number;
  session_key: string | null;
  status: FileStatus;
  error: string | null;
}

export interface SessionListItem {
  key: string;
  id: string;
  source: SourceId;
  workspaceId: string;
  workspaceName: string;
  workspaceUri?: string;
  title: string;
  createdAt: number;
  lastActivityAt: number;
  turnCount: number;
  promptCount: number;
  credits?: number;
  primaryModel?: string;
  primaryMode?: string;
}

export interface IndexSummary {
  sessions: number;
  prompts: number;
  workspaces: number;
  credits30d: number | null;
  failedFiles: number;
}

const nn = (v: number | null | undefined): number | undefined => (v === null || v === undefined ? undefined : v);

function sumOrNull(values: readonly (number | undefined)[]): number | null {
  let seen = false;
  let sum = 0;
  for (const v of values) {
    if (v === undefined) continue;
    seen = true;
    sum += v;
  }
  return seen ? sum : null;
}

function topKey(counts: Map<string, number>): string | null {
  let best: string | null = null;
  let bestN = 0;
  for (const [k, n] of counts) {
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  return best;
}

/** Builds the six FTS columns for one turn (§5.3, §5.4). */
export function buildTurnText(title: string, t: Turn, config: IndexConfig): Record<(typeof FTS_COLUMNS)[number], string> {
  const max = config.maxTurnTextKB * 1024;
  const prompt = capText(t.prompt, max);
  const response = capText(t.response, max);
  const tools = capText(t.toolCalls.map((c) => `${c.tool} ${c.args}`).join('\n'), max);
  const files = capText(expandPaths(t.files), max);
  const thinking = config.includeThinking ? capText(t.thinking, max) : '';
  const aux = capText([identifierParts(`${prompt}\n${response}\n${tools}`), thinking].filter(Boolean).join('\n'), max);
  return { title, prompt, response, tools, files, aux };
}

export const SESSION_LIST_SQL = `SELECT s.key, s.id, s.source, s.workspace_id AS workspaceId, COALESCE(w.name, s.workspace_id) AS workspaceName,
  w.uri AS workspaceUri, s.title, s.created_at AS createdAt, s.last_at AS lastActivityAt, s.turn_count AS turnCount,
  s.prompt_count AS promptCount, s.credits, s.primary_model AS primaryModel, s.primary_mode AS primaryMode
  FROM sessions s LEFT JOIN workspaces w ON w.id = s.workspace_id`;

export type ListRow = Omit<SessionListItem, 'workspaceUri' | 'credits' | 'primaryModel' | 'primaryMode'> & {
  workspaceUri: string | null;
  credits: number | null;
  primaryModel: string | null;
  primaryMode: string | null;
};

export function toListItem(r: ListRow): SessionListItem {
  return {
    ...r,
    workspaceUri: r.workspaceUri ?? undefined,
    credits: nn(r.credits),
    primaryModel: r.primaryModel ?? undefined,
    primaryMode: r.primaryMode ?? undefined,
  };
}

export class IndexDb {
  constructor(readonly store: IndexStore) {}

  // ------------------------------------------------------------ schema / meta

  createSchema(meta: { parserVersion: number; config: IndexConfig; noisePatterns: readonly string[] }): void {
    this.store.exec(SCHEMA_SQL);
    this.store.transaction(() => {
      this.setMeta(META.schemaVersion, String(SCHEMA_VERSION));
      this.setMeta(META.parserVersion, String(meta.parserVersion));
      this.setMeta(META.indexConfig, indexConfigValue(meta.config));
      this.setMeta(META.noisePatterns, JSON.stringify(meta.noisePatterns));
    });
  }

  getMeta(key: string): string | undefined {
    try {
      return this.store.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [key])?.value;
    } catch {
      return undefined;
    }
  }

  setMeta(key: string, value: string): void {
    this.store.run('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);
  }

  // ------------------------------------------------------------ workspaces / files

  workspaces(): WorkspaceRow[] {
    return this.store.all<WorkspaceRow>('SELECT id, source, name, uri, fingerprint FROM workspaces');
  }

  upsertWorkspace(w: { id: string; source: string; name: string; uri?: string }): void {
    this.store.run(
      `INSERT INTO workspaces(id, source, name, uri, fingerprint) VALUES (?, ?, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET source = excluded.source, name = excluded.name, uri = excluded.uri`,
      [w.id, w.source, w.name, w.uri ?? null],
    );
  }

  setWorkspaceFingerprint(id: string, fingerprint: string | null): void {
    this.store.run('UPDATE workspaces SET fingerprint = ? WHERE id = ?', [fingerprint, id]);
  }

  deleteWorkspace(id: string): void {
    this.store.run('DELETE FROM workspaces WHERE id = ?', [id]);
  }

  file(path: string): FileRow | undefined {
    return this.store.get<FileRow>('SELECT * FROM files WHERE path = ?', [path]);
  }

  filesOfWorkspace(workspaceId: string): FileRow[] {
    return this.store.all<FileRow>('SELECT * FROM files WHERE workspace_id = ?', [workspaceId]);
  }

  filesOfSession(key: string): FileRow[] {
    return this.store.all<FileRow>('SELECT * FROM files WHERE session_key = ? ORDER BY path', [key]);
  }

  upsertFile(r: FileRow): void {
    this.store.run(
      `INSERT INTO files(path, source, workspace_id, mtime, size, parser_version, session_key, status, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET source = excluded.source, workspace_id = excluded.workspace_id, mtime = excluded.mtime,
         size = excluded.size, parser_version = excluded.parser_version, session_key = excluded.session_key,
         status = excluded.status, error = excluded.error`,
      [r.path, r.source, r.workspace_id, r.mtime, r.size, r.parser_version, r.session_key, r.status, r.error],
    );
  }

  setFileStatus(path: string, status: FileStatus, sessionKey: string | null): void {
    this.store.run('UPDATE files SET status = ?, session_key = ? WHERE path = ?', [status, sessionKey, path]);
  }

  deleteFile(path: string): void {
    this.store.run('DELETE FROM files WHERE path = ?', [path]);
  }

  failedFileCount(): number {
    return this.store.get<{ n: number }>("SELECT count(*) AS n FROM files WHERE status = 'failed'")?.n ?? 0;
  }

  // ------------------------------------------------------------ sessions

  sessionFile(key: string): string | undefined {
    return this.store.get<{ file_path: string }>('SELECT file_path FROM sessions WHERE key = ?', [key])?.file_path;
  }

  deleteSession(key: string): void {
    const s = this.store;
    s.run(
      `INSERT INTO turn_fts(turn_fts, rowid, title, prompt, response, tools, files, aux)
       SELECT 'delete', x.id, x.title, x.prompt, x.response, x.tools, x.files, x.aux
       FROM turn_text x WHERE x.id IN (SELECT id FROM turns WHERE session_key = ?)`,
      [key],
    );
    s.run('DELETE FROM turn_text WHERE id IN (SELECT id FROM turns WHERE session_key = ?)', [key]);
    s.run('DELETE FROM turn_tools WHERE turn_id IN (SELECT id FROM turns WHERE session_key = ?)', [key]);
    s.run('DELETE FROM turns WHERE session_key = ?', [key]);
    s.run('DELETE FROM sessions WHERE key = ?', [key]);
  }

  /** Replaces a session with freshly parsed data. Returns the number of turns written. */
  writeSession(
    key: string,
    parsed: ParsedSession,
    file: { path: string; source: SourceId; workspaceId: string; size: number },
    config: IndexConfig,
  ): number {
    this.deleteSession(key);
    const s = this.store;
    const visible = parsed.turns.filter((t) => !t.hidden);
    const models = new Map<string, number>();
    const modes = new Map<string, number>();
    for (const t of visible) {
      if (t.model) models.set(t.model, (models.get(t.model) ?? 0) + 1);
      if (t.mode) modes.set(t.mode, (modes.get(t.mode) ?? 0) + 1);
    }
    const prompts = visible.filter((t) => t.prompt.trim() !== '');
    s.run(
      `INSERT INTO sessions(key, id, file_path, source, workspace_id, title, custom_title, created_at, last_at, turn_count, prompt_count,
        noise_count, canceled_count, tool_call_count, prompt_tokens, completion_tokens, credits, elapsed_ms, size_bytes, primary_model, primary_mode)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        key,
        parsed.id,
        file.path,
        file.source,
        file.workspaceId,
        parsed.title,
        parsed.customTitle ? 1 : 0,
        parsed.createdAt,
        parsed.lastActivityAt,
        visible.length,
        prompts.length,
        prompts.filter((t) => t.noise).length,
        visible.filter((t) => t.canceled).length,
        parsed.turns.reduce((n, t) => n + t.toolCalls.length, 0),
        sumOrNull(parsed.turns.map((t) => t.promptTokens)),
        sumOrNull(parsed.turns.map((t) => t.completionTokens)),
        sumOrNull(parsed.turns.map((t) => t.credits)),
        sumOrNull(parsed.turns.map((t) => t.elapsedMs)),
        file.size,
        topKey(models),
        topKey(modes),
      ],
    );
    for (const t of parsed.turns) {
      const { lastInsertRowid: id } = s.run(
        `INSERT INTO turns(session_key, idx, ts, model, mode, prompt_tokens, completion_tokens, credits, elapsed_ms, hidden, canceled, noise)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [key, t.index, t.timestamp, t.model ?? null, t.mode ?? null, t.promptTokens ?? null, t.completionTokens ?? null, t.credits ?? null, t.elapsedMs ?? null, t.hidden ? 1 : 0, t.canceled ? 1 : 0, t.noise ? 1 : 0],
      );
      const toolCounts = new Map<string, number>();
      for (const c of t.toolCalls) toolCounts.set(c.tool, (toolCounts.get(c.tool) ?? 0) + 1);
      for (const [tool, count] of toolCounts) s.run('INSERT INTO turn_tools(turn_id, tool, count) VALUES (?, ?, ?)', [id, tool, count]);
      const tx = buildTurnText(parsed.title, t, config);
      const cols: SqlValue[] = [id, tx.title, tx.prompt, tx.response, tx.tools, tx.files, tx.aux];
      s.run('INSERT INTO turn_text(id, title, prompt, response, tools, files, aux) VALUES (?, ?, ?, ?, ?, ?, ?)', cols);
      s.run('INSERT INTO turn_fts(rowid, title, prompt, response, tools, files, aux) VALUES (?, ?, ?, ?, ?, ?, ?)', cols);
    }
    return parsed.turns.length;
  }

  /** R5.17 – re-flags noise from stored prompts and recomputes non-custom titles. Returns changed sessions. */
  reflagNoise(isNoise: (prompt: string) => boolean): number {
    const s = this.store;
    const rows = s.all<{ id: number; key: string; prompt: string; noise: number; hidden: number }>(
      'SELECT t.id, t.session_key AS key, x.prompt, t.noise, t.hidden FROM turns t JOIN turn_text x ON x.id = t.id ORDER BY t.session_key, t.idx',
    );
    const bySession = new Map<string, { id: number; prompt: string; noise: boolean; hidden: boolean; changed: boolean }[]>();
    for (const r of rows) {
      const noise = isNoise(r.prompt);
      const list = bySession.get(r.key) ?? [];
      list.push({ id: r.id, prompt: r.prompt, noise, hidden: r.hidden === 1, changed: noise !== (r.noise === 1) });
      bySession.set(r.key, list);
    }
    let changedSessions = 0;
    for (const [key, turns] of bySession) {
      if (!turns.some((t) => t.changed)) continue;
      changedSessions++;
      for (const t of turns) if (t.changed) s.run('UPDATE turns SET noise = ? WHERE id = ?', [t.noise ? 1 : 0, t.id]);
      const noiseCount = turns.filter((t) => !t.hidden && t.noise && t.prompt.trim() !== '').length;
      s.run('UPDATE sessions SET noise_count = ? WHERE key = ?', [noiseCount, key]);
      const session = s.get<{ custom_title: number; title: string }>('SELECT custom_title, title FROM sessions WHERE key = ?', [key]);
      if (session && session.custom_title !== 1) {
        const title = deriveTitle(turns);
        if (title !== session.title) this.retitle(key, title);
      }
    }
    return changedSessions;
  }

  private retitle(key: string, title: string): void {
    const s = this.store;
    s.run('UPDATE sessions SET title = ? WHERE key = ?', [title, key]);
    const ids = s.all<{ id: number }>('SELECT id FROM turns WHERE session_key = ?', [key]).map((r) => r.id);
    for (const id of ids) {
      const x = s.get<Record<string, string>>('SELECT title, prompt, response, tools, files, aux FROM turn_text WHERE id = ?', [id]);
      if (!x) continue;
      const cols = FTS_COLUMNS.map((c) => x[c] ?? '');
      s.run(`INSERT INTO turn_fts(turn_fts, rowid, ${FTS_COLUMNS.join(', ')}) VALUES ('delete', ?, ?, ?, ?, ?, ?, ?)`, [id, ...cols]);
      s.run('UPDATE turn_text SET title = ? WHERE id = ?', [title, id]);
      s.run(`INSERT INTO turn_fts(rowid, ${FTS_COLUMNS.join(', ')}) VALUES (?, ?, ?, ?, ?, ?, ?)`, [id, title, ...cols.slice(1)]);
    }
  }

  optimize(): void {
    this.store.exec("INSERT INTO turn_fts(turn_fts) VALUES ('optimize')");
  }

  // ------------------------------------------------------------ reads for the UI

  listSessions(filter: { workspaceId?: string; sources?: readonly string[]; models?: readonly string[]; modes?: readonly string[]; after?: number; before?: number } = {}): SessionListItem[] {
    const where: string[] = ['s.turn_count > 0'];
    const params: SqlValue[] = [];
    if (filter.workspaceId) {
      where.push('s.workspace_id = ?');
      params.push(filter.workspaceId);
    }
    const inList = (col: string, values: readonly string[] | undefined): void => {
      if (!values?.length) return;
      where.push(`${col} IN (SELECT value FROM json_each(?))`);
      params.push(JSON.stringify(values));
    };
    inList('s.source', filter.sources);
    inList('s.primary_model', filter.models);
    inList('s.primary_mode', filter.modes);
    if (filter.after !== undefined) {
      where.push('s.last_at >= ?');
      params.push(filter.after);
    }
    if (filter.before !== undefined) {
      where.push('s.last_at < ?');
      params.push(filter.before);
    }
    return this.store.all<ListRow>(`${SESSION_LIST_SQL} WHERE ${where.join(' AND ')} ORDER BY s.last_at DESC`, params).map(toListItem);
  }

  facets(): { models: string[]; modes: string[]; sources: string[] } {
    const col = (c: string): string[] =>
      this.store.all<{ v: string }>(`SELECT DISTINCT ${c} AS v FROM sessions WHERE ${c} IS NOT NULL AND turn_count > 0 ORDER BY v`).map((r) => r.v);
    return { models: col('primary_model'), modes: col('primary_mode'), sources: col('source') };
  }

  sessionMeta(key: string): SessionMeta | undefined {
    const s = this.store.get<{
      key: string;
      id: string;
      source: SourceId;
      workspace_id: string;
      wname: string | null;
      wuri: string | null;
      file_path: string;
      title: string;
      created_at: number;
      last_at: number;
      turn_count: number;
      prompt_count: number;
      noise_count: number;
      canceled_count: number;
      tool_call_count: number;
      prompt_tokens: number | null;
      completion_tokens: number | null;
      credits: number | null;
      elapsed_ms: number | null;
      size_bytes: number;
    }>('SELECT s.*, w.name AS wname, w.uri AS wuri FROM sessions s LEFT JOIN workspaces w ON w.id = s.workspace_id WHERE s.key = ?', [key]);
    if (!s) return undefined;
    const counts = (sql: string): Record<string, number> => Object.fromEntries(this.store.all<{ k: string; n: number }>(sql, [key]).map((r) => [r.k, r.n]));
    const copies = this.store.all<{ workspaceId: string; workspaceName: string | null; filePath: string }>(
      `SELECT f.workspace_id AS workspaceId, w.name AS workspaceName, f.path AS filePath FROM files f
       LEFT JOIN workspaces w ON w.id = f.workspace_id WHERE f.session_key = ? AND f.status = 'duplicate' ORDER BY f.path`,
      [key],
    );
    return {
      key: s.key,
      id: s.id,
      source: s.source,
      workspaceId: s.workspace_id,
      workspaceName: s.wname ?? s.workspace_id,
      workspaceUri: s.wuri ?? undefined,
      filePath: s.file_path,
      copies: copies.map((c) => ({ workspaceId: c.workspaceId, workspaceName: c.workspaceName ?? c.workspaceId, filePath: c.filePath })),
      title: s.title,
      createdAt: s.created_at,
      lastActivityAt: s.last_at,
      turnCount: s.turn_count,
      promptCount: s.prompt_count,
      noisePromptCount: s.noise_count,
      canceledCount: s.canceled_count,
      toolCallCount: s.tool_call_count,
      models: counts('SELECT model AS k, count(*) AS n FROM turns WHERE session_key = ? AND hidden = 0 AND model IS NOT NULL GROUP BY model ORDER BY n DESC'),
      modes: counts('SELECT mode AS k, count(*) AS n FROM turns WHERE session_key = ? AND hidden = 0 AND mode IS NOT NULL GROUP BY mode ORDER BY n DESC'),
      tools: counts('SELECT tt.tool AS k, sum(tt.count) AS n FROM turn_tools tt JOIN turns t ON t.id = tt.turn_id WHERE t.session_key = ? GROUP BY tt.tool ORDER BY n DESC'),
      promptTokens: nn(s.prompt_tokens),
      completionTokens: nn(s.completion_tokens),
      credits: nn(s.credits),
      elapsedMs: nn(s.elapsed_ms),
      sizeBytes: s.size_bytes,
    };
  }

  summary(now = Date.now()): IndexSummary {
    const r = this.store.get<{ sessions: number; prompts: number | null; workspaces: number }>(
      'SELECT count(*) AS sessions, sum(prompt_count) AS prompts, count(DISTINCT workspace_id) AS workspaces FROM sessions WHERE turn_count > 0',
    );
    const c = this.store.get<{ credits: number | null }>('SELECT sum(credits) AS credits FROM turns WHERE ts >= ? AND hidden = 0', [now - 30 * 86_400_000]);
    return { sessions: r?.sessions ?? 0, prompts: r?.prompts ?? 0, workspaces: r?.workspaces ?? 0, credits30d: c?.credits ?? null, failedFiles: this.failedFileCount() };
  }
}
