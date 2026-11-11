import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseVsCodeFile } from '../core/parser-vscode';
import { isNoise } from '../core/text';
import { buildPreviewData } from '../ui/preview-data';
import { MAIN_JSONL, MAIN_ID } from '../test/helpers';
import type { SessionMeta } from '../core/model';
import { findRanges, fold } from './preview/highlight';
import { renderMarkdown } from './preview/markdown';
import { HostToWebviewSchema, WebviewToHostSchema } from './protocol';

describe('markdown renderer (R7.24)', () => {
  it('never passes raw HTML through', () => {
    const out = renderMarkdown('<script>alert(1)</script> <img src=x onerror=alert(1)> **bold**');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;script&gt;');
    expect(out).toContain('<strong>bold</strong>');
  });

  it('only links http(s), file and in-page targets', () => {
    expect(renderMarkdown('[a](javascript:alert(1))')).not.toContain('<a');
    expect(renderMarkdown('[a](data:text/html,x)')).not.toContain('<a');
    expect(renderMarkdown('[a](vscode://x)')).not.toContain('<a');
    expect(renderMarkdown('[a](https://example.com)')).toContain('<a href="https://example.com">');
    expect(renderMarkdown('[parser.ts](file:///home/user/src/parser.ts)')).toContain('href="file:///home/user/src/parser.ts"');
  });

  it('drops images (no remote resources)', () => {
    expect(renderMarkdown('![x](https://example.com/a.png)')).not.toContain('<img');
  });

  it('highlights code locally and escapes unknown languages', () => {
    expect(renderMarkdown('```ts\nconst a = "<b>";\n```')).toContain('<span class="hljs-keyword">const</span>');
    expect(renderMarkdown('```ts\nconst a = "<b>";\n```')).toContain('&lt;b&gt;');
    expect(renderMarkdown('```nope\n<b>x</b>\n```')).toContain('&lt;b&gt;x&lt;/b&gt;');
  });
});

describe('term highlighting (R7.23)', () => {
  it('folds case and diacritics with an index map', () => {
    const f = fold('Členů');
    expect(f.text).toBe('clenu');
    expect(f.map).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('finds terms diacritics-insensitively and maps back to original offsets', () => {
    const s = 'Test Členů and členů, ČLENŮ.';
    expect(findRanges(s, ['clenu']).map(([a, b]) => s.slice(a, b))).toEqual(['Členů', 'členů', 'ČLENŮ']);
    expect(findRanges('abc', [])).toEqual([]);
    expect(findRanges('abc', [''])).toEqual([]);
    expect(findRanges('open session now', ['open session', 'now'])).toEqual([
      [0, 12],
      [13, 16],
    ]);
  });

  it('handles decomposed input', () => {
    const s = 'C\u030clenu';
    expect(findRanges(s, ['člen'])).toEqual([[0, 5]]);
  });
});

describe('preview data', () => {
  const meta = (title: string): SessionMeta => ({
    key: `vscode:${MAIN_ID}`,
    id: MAIN_ID,
    source: 'vscode',
    workspaceId: 'vscode:x',
    workspaceName: 'sample-app',
    filePath: MAIN_JSONL,
    copies: [],
    title,
    createdAt: 1,
    lastActivityAt: 2,
    turnCount: 2,
    promptCount: 2,
    noisePromptCount: 1,
    canceledCount: 1,
    toolCallCount: 2,
    models: { m: 2 },
    modes: { Agent: 2 },
    tools: {},
    sizeBytes: 1,
  });

  it('keeps visible turns, checks file existence and redacts on request (R7.25, R10.8)', async () => {
    const parsed = (await parseVsCodeFile({ path: MAIN_JSONL, kind: 'jsonl' }, { maxFieldChars: 1e6, isNoise, withParts: true }))!;
    const secret = `ghp_${'b'.repeat(36)}`;
    parsed.turns[0]!.prompt += ` ${secret}`;
    parsed.turns[0]!.files.push(MAIN_JSONL);
    const loaded = { meta: meta(`title ${secret}`), turns: parsed.turns };
    const red = await buildPreviewData(loaded, true);
    expect(red.turns.map((t) => t.index)).toEqual([0, 1]);
    expect(red.hiddenTurns).toBe(1);
    expect(JSON.stringify(red)).not.toContain(secret);
    expect(red.title).toContain('[REDACTED:github-token]');
    expect(red.files.map((f) => [f.label, f.exists])).toEqual([
      ['parser.ts', false],
      ['parser-utils.ts', false],
      [path.basename(MAIN_JSONL), true],
    ]);
    expect(red.turns[0]!.files).toEqual([0, 1, 2]);
    expect(red.turns[0]!.parts.map((p) => p.kind)).toEqual(['thinking', 'tool', 'tool', 'markdown']);
    const raw = await buildPreviewData(loaded, false);
    expect(JSON.stringify(raw)).toContain(secret);
    expect(HostToWebviewSchema.safeParse({ type: 'init', data: raw, terms: ['x'], redacted: false, canOpenInChat: true, canOpenNewWindow: false, openInChatLabel: 'a', newWindowLabel: 'b' }).success).toBe(true);
  });
});

describe('webview message validation (R7.20)', () => {
  it('accepts known messages and rejects everything else', () => {
    expect(WebviewToHostSchema.safeParse({ type: 'openFile', file: 2 }).success).toBe(true);
    expect(WebviewToHostSchema.safeParse({ type: 'openFile', file: '/etc/passwd' }).success).toBe(false);
    expect(WebviewToHostSchema.safeParse({ type: 'openFile', file: -1 }).success).toBe(false);
    expect(WebviewToHostSchema.safeParse({ type: 'runCommand', command: 'x' }).success).toBe(false);
    expect(WebviewToHostSchema.safeParse({ type: 'openLink', href: 'x'.repeat(5000) }).success).toBe(false);
    expect(HostToWebviewSchema.safeParse({ type: 'error' }).success).toBe(false);
    expect(HostToWebviewSchema.safeParse({ type: 'reveal', terms: [], scrollTo: 2 }).success).toBe(true);
  });
});
