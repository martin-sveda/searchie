import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Pending-open request (R8.7): written before `vscode.openFolder`, consumed by the window that holds the workspace. */

export interface PendingOpen {
  sessionId: string;
  source: string;
  /** The session's workspace ids, including duplicate copies (R5.19); empty for an empty-window session. */
  workspaceIds: string[];
  emptyWindow: boolean;
  createdAt: number;
}

export const PENDING_FILE = 'pending-open.json';
export const PENDING_MAX_AGE_MS = 60_000;

export function writePendingOpen(dir: string, request: Omit<PendingOpen, 'createdAt'>, now = Date.now()): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `${PENDING_FILE}.${randomUUID()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ ...request, createdAt: now } satisfies PendingOpen), { mode: 0o600 });
  fs.renameSync(tmp, path.join(dir, PENDING_FILE));
}

function parse(raw: string): PendingOpen | undefined {
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== 'object') return undefined;
    const o = v as Record<string, unknown>;
    if (typeof o.sessionId !== 'string' || typeof o.source !== 'string' || typeof o.createdAt !== 'number' || typeof o.emptyWindow !== 'boolean') return undefined;
    if (!Array.isArray(o.workspaceIds) || !o.workspaceIds.every((x) => typeof x === 'string')) return undefined;
    return { sessionId: o.sessionId, source: o.source, workspaceIds: o.workspaceIds, emptyWindow: o.emptyWindow, createdAt: o.createdAt };
  } catch {
    return undefined;
  }
}

export interface ConsumeContext {
  source: string;
  workspaceId: string;
  isEmptyWindow: boolean;
  /** Empty-window requests are only taken by a window that is starting up (the new one), not by watchers. */
  startup: boolean;
  now?: number;
}

/**
 * Claims the request if it targets this window: matching source, and this window's workspace id is one of the
 * session's workspaces (or both are empty windows). Stale (> 60 s) or invalid requests are deleted.
 * The claim is an atomic rename, so two windows can't both take it.
 */
export function consumePendingOpen(dir: string, ctx: ConsumeContext): PendingOpen | undefined {
  const file = path.join(dir, PENDING_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  const req = parse(raw);
  const now = ctx.now ?? Date.now();
  if (!req || now - req.createdAt > PENDING_MAX_AGE_MS || req.createdAt > now + 5_000) {
    fs.rmSync(file, { force: true });
    return undefined;
  }
  if (req.source !== ctx.source) return undefined;
  const matches = req.emptyWindow ? ctx.isEmptyWindow && ctx.startup : !ctx.isEmptyWindow && req.workspaceIds.includes(ctx.workspaceId);
  if (!matches) return undefined;
  const claimed = path.join(dir, `${PENDING_FILE}.${randomUUID()}.claimed`);
  try {
    fs.renameSync(file, claimed);
  } catch {
    return undefined;
  }
  // A newer request may have replaced the file between read and rename: verify what was actually claimed.
  let claimedReq: PendingOpen | undefined;
  try {
    claimedReq = parse(fs.readFileSync(claimed, 'utf8'));
  } catch {
    claimedReq = undefined;
  }
  if (!claimedReq || claimedReq.sessionId !== req.sessionId || claimedReq.createdAt !== req.createdAt) {
    if (claimedReq && !fs.existsSync(file)) fs.renameSync(claimed, file);
    else fs.rmSync(claimed, { force: true });
    return undefined;
  }
  fs.rmSync(claimed, { force: true });
  return req;
}
