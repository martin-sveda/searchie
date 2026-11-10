import fs from 'node:fs';
import path from 'node:path';
import { SOURCE_LABELS } from '../core/ids';
import { redactSecrets } from '../core/vendor/redact-secrets';
import type { PreviewData } from '../webview/protocol';
import type { LoadedSession } from '../worker/protocol';
import { UNTITLED } from './format';

/** Preview payload construction (no vscode dependency, unit-tested). */

export async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(p)).isFile();
  } catch {
    return false;
  }
}

/** Builds the webview payload: visible turns only, files with an existence check (R10.8), optional redaction. */
export async function buildPreviewData(loaded: LoadedSession, redact: boolean): Promise<PreviewData> {
  const r = (s: string): string => (redact ? redactSecrets(s) : s);
  const { meta } = loaded;
  const visible = loaded.turns.filter((t) => !t.hidden);
  const fileIndex = new Map<string, number>();
  const files: PreviewData['files'] = [];
  for (const t of visible) {
    for (const f of t.files) {
      if (fileIndex.has(f)) continue;
      fileIndex.set(f, files.length);
      files.push({ label: path.basename(f.replaceAll('\\', '/')), path: f, exists: false });
    }
  }
  await Promise.all(files.map(async (f) => (f.exists = await isFile(f.path))));
  return {
    title: r(meta.title || UNTITLED),
    workspaceName: meta.workspaceName,
    sourceLabel: SOURCE_LABELS[meta.source],
    createdAt: meta.createdAt,
    lastActivityAt: meta.lastActivityAt,
    models: Object.keys(meta.models),
    modes: Object.keys(meta.modes),
    promptTokens: meta.promptTokens,
    completionTokens: meta.completionTokens,
    credits: meta.credits,
    turnCount: meta.turnCount,
    hiddenTurns: loaded.turns.length - visible.length,
    files,
    turns: visible.map((t) => ({
      index: t.index,
      timestamp: t.timestamp,
      prompt: r(t.prompt),
      parts: (t.parts ?? []).map((p) => (p.kind === 'tool' ? { ...p, args: r(p.args) } : { ...p, text: r(p.text) })),
      files: t.files.map((f) => fileIndex.get(f)!).filter((i) => i !== undefined),
      model: t.model,
      mode: t.mode,
      canceled: t.canceled,
      noise: t.noise,
    })),
  };
}

