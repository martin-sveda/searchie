import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_EVENTS, CLI_ID, copyFixtureCliRoot, tempDir, writeJsonl } from '../test/helpers';
import { cliParser, parserFor } from './parsers';
import { parseCliFile } from './parser-cli';
import type { ParseOptions } from './parser-vscode';
import { createNoiseMatcher, isNoise } from './text';

const OPTS: ParseOptions = { maxFieldChars: 64 * 1024, isNoise };
const FOLDER = '/home/user/projects/sample-app';

describe('parseCliFile – fixture 4444… (fixtures README)', () => {
  it('maps session-level fields from session.start and workspace.yaml', async () => {
    const s = (await parseCliFile({ path: CLI_EVENTS }, OPTS))!;
    expect(s.id).toBe(CLI_ID);
    expect(s.title).toBe('Sample CLI session');
    expect(s.customTitle).toBe(true);
    expect(s.createdAt).toBe(Date.parse('2026-01-15T11:00:00.000Z'));
    expect(s.lastActivityAt).toBeGreaterThanOrEqual(Date.parse('2026-01-15T11:02:00.000Z'));
    expect(s.turns).toHaveLength(3);
  });

  it('turn 0: sub-agent excluded, tools, files, tokens, credits, elapsed', async () => {
    const t = (await parseCliFile({ path: CLI_EVENTS }, OPTS))!.turns[0]!;
    expect(t.prompt).toBe('Add a unit test for parseJsonLine.');
    expect(t.toolCalls.map((c) => c.tool)).toEqual(['view', 'create']);
    expect(t.files.sort()).toEqual([`${FOLDER}/src/parser.ts`, `${FOLDER}/test/parser.test.ts`]);
    expect(t.response).toContain('I will look at the parser first.');
    expect(t.response).toContain('Added a placeholder test');
    expect(t.response).not.toContain('SUB-AGENT');
    expect(t.thinking).toBe('Placeholder CLI reasoning.');
    expect(t).toMatchObject({ promptTokens: 21_500, completionTokens: 450, credits: 3.6, elapsedMs: 12_000, model: 'claude-sonnet-5.5', mode: 'interactive', hidden: false, canceled: false });
  });

  it('turn 1: autopilot, bash, canceled, no response, missing tokens stay undefined', async () => {
    const t = (await parseCliFile({ path: CLI_EVENTS }, OPTS))!.turns[1]!;
    expect(t).toMatchObject({ prompt: 'Now run the tests.', mode: 'autopilot', canceled: true, response: '', model: 'gpt-6.1-sol' });
    expect(t.toolCalls).toEqual([{ tool: 'bash', args: 'npm test' }]);
    expect(t.promptTokens).toBeUndefined();
    expect(t.credits).toBeUndefined();
    expect(t.elapsedMs).toBeUndefined();
  });

  it('turn 2: autopilot continuation is hidden; model after model_change; credits 0.7', async () => {
    const t = (await parseCliFile({ path: CLI_EVENTS }, OPTS))!.turns[2]!;
    expect(t).toMatchObject({ hidden: true, model: 'gpt-6.1-sol', credits: 0.7, noise: true });
  });

  it('never keeps system prompts, tool output, sub-agent text, generated file text or image bytes', async () => {
    const json = JSON.stringify(await parseCliFile({ path: CLI_EVENTS }, { ...OPTS, withParts: true }));
    for (const banned of ['SYSTEM PROMPT', 'TOOL OUTPUT', 'SUB-AGENT', 'GENERATED CODE', 'iVBORw0KGgo', 'transformed']) expect(json).not.toContain(banned);
  });

  it('counts skipped and unknown event types', async () => {
    const s = (await parseCliFile({ path: CLI_EVENTS }, OPTS))!;
    expect(s.diagnostics).toMatchObject({ malformed: 0, unknownKinds: 0, oversized: 0 });
    expect(s.diagnostics.lines).toBeGreaterThan(20);
  });

  it('keeps ordered parts for Preview', async () => {
    const s = (await parseCliFile({ path: CLI_EVENTS }, { ...OPTS, withParts: true }))!;
    expect(s.turns[0]!.parts!.filter((p) => p.kind === 'tool').map((p) => p.kind === 'tool' && p.tool)).toEqual(['view', 'create']);
    expect(s.turns[0]!.parts!.some((p) => p.kind === 'thinking')).toBe(true);
  });

  it('is registered for the copilot-cli source', () => {
    expect(parserFor({ path: CLI_EVENTS, source: 'copilot-cli', kind: 'jsonl' })).toBe(cliParser);
  });
});

describe('parseCliFile – edge cases', () => {
  const ev = (type: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}, ts = '2026-02-01T10:00:00.000Z'): Record<string, unknown> => ({
    type,
    data,
    id: 'x',
    timestamp: ts,
    ...extra,
  });

  it('falls back without workspace.yaml and session.start: dir name, first prompt, mode_changed, MCP tools, incomplete credits', async () => {
    const dir = path.join(tempDir(), 'abc-session');
    const file = writeJsonl(dir, 'events.jsonl', [
      ev('session.mode_changed', { newMode: 'plan' }),
      ev('user.message', { content: 'Plan the placeholder feature' }),
      ev('tool.execution_start', { toolName: 'report_intent', arguments: { intent: 'x' } }),
      ev('tool.execution_start', { toolName: 'list_issues', mcpServerName: 'github', mcpToolName: 'list_issues', arguments: { query: 'is:open', other: 'ignored' } }),
      ev('tool.execution_start', { toolName: 'glob', arguments: { pattern: '**/*.ts', path: '/w/src', paths: ['/a', 3] } }),
      ev('session.usage_record', { usage: { inputTokens: 10, outputTokens: 2, aiCreditsStatus: 'pending', copilotUsage: { totalNanoAiu: 5e9 } } }),
      ev('assistant.message', { content: 'sub', model: 'm' }, { agentId: 'a1' }),
      ev('assistant.message', { content: 'reply', model: 'm2' }),
      ev('assistant.turn_end', {}, {}, '2026-02-01T10:00:05.000Z'),
      ev('brand.new_event', { x: 1 }),
      ev('hook.start', {}),
    ], ['{broken', '[1,2]']);
    const s = (await parseCliFile({ path: file }, OPTS))!;
    expect(s.id).toBe('abc-session');
    expect(s.title).toBe('Plan the placeholder feature');
    expect(s.customTitle).toBe(false);
    const t = s.turns[0]!;
    expect(t.mode).toBe('plan');
    expect(t.toolCalls).toEqual([
      { tool: 'github/list_issues', args: 'is:open' },
      { tool: 'glob', args: '/w/src /a **/*.ts' },
    ]);
    expect(t.files).toEqual(['/w/src']);
    expect(t).toMatchObject({ promptTokens: 10, completionTokens: 2, credits: undefined, elapsedMs: 5000, model: 'm2', response: 'reply' });
    expect(s.diagnostics).toMatchObject({ unknownKinds: 1, malformed: 2 });
  });

  it('ignores events before the first prompt and applies user noise patterns', async () => {
    const dir = path.join(tempDir(), 's');
    const file = writeJsonl(dir, 'events.jsonl', [
      ev('assistant.message', { content: 'orphan' }),
      ev('user.message', { content: 'pokračuj', source: undefined }),
    ]);
    const s = (await parseCliFile({ path: file }, { ...OPTS, isNoise: createNoiseMatcher(['pokračuj']) }))!;
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0]!.noise).toBe(true);
    expect(s.turns[0]!.response).toBe('');
    expect(s.title).toBe('');
  });

  it('returns null for an empty file and throws for unparseable or oversized-only files', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'events.jsonl'), '');
    expect(await parseCliFile({ path: path.join(dir, 'events.jsonl') }, OPTS)).toBeNull();
    fs.writeFileSync(path.join(dir, 'events.jsonl'), '{not json\n');
    await expect(parseCliFile({ path: path.join(dir, 'events.jsonl') }, OPTS)).rejects.toThrow('unparseable');
    fs.writeFileSync(path.join(dir, 'events.jsonl'), `{"type":"user.message","data":{"content":"${'x'.repeat(5000)}"}}\n`);
    await expect(parseCliFile({ path: path.join(dir, 'events.jsonl') }, { ...OPTS, maxLineChars: 100 })).rejects.toThrow('oversized');
  });

  it('caps fields and reads the session id from workspace.yaml when session.start is missing', async () => {
    const root = copyFixtureCliRoot();
    const dir = path.join(root, 'yaml-only');
    writeJsonl(dir, 'events.jsonl', [ev('user.message', { content: 'y'.repeat(500) })]);
    fs.writeFileSync(path.join(dir, 'workspace.yaml'), 'id: from-yaml\nname: "Quoted \\"title\\""\ncreated_at: 2026-01-01T00:00:00.000Z\n');
    const s = (await parseCliFile({ path: path.join(dir, 'events.jsonl') }, { ...OPTS, maxFieldChars: 50 }))!;
    expect(s.id).toBe('from-yaml');
    expect(s.title).toBe('Quoted "title"');
    expect(s.createdAt).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
    expect(s.turns[0]!.prompt).toHaveLength(50);
  });
});
