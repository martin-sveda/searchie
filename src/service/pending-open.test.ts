import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../test/helpers';
import { consumePendingOpen, PENDING_FILE, PENDING_MAX_AGE_MS, writePendingOpen } from './pending-open';

const NOW = 1_800_000_000_000;
const ctx = { source: 'vscode', workspaceId: 'vscode:abc', isEmptyWindow: false, startup: true, now: NOW + 1000 };

describe('pending-open request (R8.7)', () => {
  it('is consumed once by the matching workspace window', () => {
    const dir = tempDir();
    writePendingOpen(dir, { sessionId: 's1', source: 'vscode', workspaceIds: ['vscode:other', 'vscode:abc'], emptyWindow: false }, NOW);
    if (process.platform !== 'win32') expect(fs.statSync(path.join(dir, PENDING_FILE)).mode & 0o777).toBe(0o600);
    expect(consumePendingOpen(dir, { ...ctx, workspaceId: 'vscode:nope' })).toBeUndefined();
    expect(consumePendingOpen(dir, { ...ctx, source: 'vscode-insiders' })).toBeUndefined();
    expect(consumePendingOpen(dir, { ...ctx, isEmptyWindow: true })).toBeUndefined();
    expect(consumePendingOpen(dir, { ...ctx, startup: false })?.sessionId).toBe('s1');
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(consumePendingOpen(dir, ctx)).toBeUndefined();
  });

  it('gives empty-window requests only to a starting empty window (R8.4)', () => {
    const dir = tempDir();
    writePendingOpen(dir, { sessionId: 'e1', source: 'vscode', workspaceIds: [], emptyWindow: true }, NOW);
    expect(consumePendingOpen(dir, { ...ctx, isEmptyWindow: true, startup: false })).toBeUndefined();
    expect(consumePendingOpen(dir, { ...ctx, isEmptyWindow: false })).toBeUndefined();
    expect(consumePendingOpen(dir, { ...ctx, isEmptyWindow: true, workspaceId: 'vscode:empty-window' })?.sessionId).toBe('e1');
  });

  it('deletes stale, future and invalid requests', () => {
    const dir = tempDir();
    writePendingOpen(dir, { sessionId: 's', source: 'vscode', workspaceIds: ['vscode:abc'], emptyWindow: false }, NOW);
    expect(consumePendingOpen(dir, { ...ctx, now: NOW + PENDING_MAX_AGE_MS + 1 })).toBeUndefined();
    expect(fs.existsSync(path.join(dir, PENDING_FILE))).toBe(false);
    writePendingOpen(dir, { sessionId: 's', source: 'vscode', workspaceIds: ['vscode:abc'], emptyWindow: false }, NOW + 60_000);
    expect(consumePendingOpen(dir, ctx)).toBeUndefined();
    for (const bad of ['{', '[]', JSON.stringify({ sessionId: 1 }), JSON.stringify({ sessionId: 's', source: 'vscode', createdAt: NOW, emptyWindow: false, workspaceIds: [1] })]) {
      fs.writeFileSync(path.join(dir, PENDING_FILE), bad);
      expect(consumePendingOpen(dir, ctx)).toBeUndefined();
      expect(fs.existsSync(path.join(dir, PENDING_FILE))).toBe(false);
    }
    expect(consumePendingOpen(path.join(dir, 'missing'), ctx)).toBeUndefined();
  });
});
