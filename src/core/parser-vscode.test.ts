import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_WINDOW_ID,
  EMPTY_WINDOW_JSONL,
  LEGACY_ID,
  LEGACY_JSON,
  MAIN_COPY_JSONL,
  MAIN_ID,
  MAIN_JSONL,
  NEVER_INDEXED,
  placeholderRequest,
  tempDir,
  writeJsonl,
} from '../test/helpers';
import { parserFor, parserSignature, vscodeParser } from './parsers';
import {
  deriveTitle,
  mapVsCodeSession,
  type ParseOptions,
  parseVsCodeFile,
  preStripHeavy,
  pruneVsCodeEntry,
  SessionParseError,
} from './parser-vscode';
import { createNoiseMatcher, isNoise } from './text';
import type { JsonValue } from './vendor/replay';

const OPTS: ParseOptions = { maxFieldChars: 64 * 1024, isNoise };
const FOLDER = '/home/user/projects/sample-app';

describe('parseVsCodeFile – main .jsonl fixture', () => {
  it('maps turn 0 per the fixture README', async () => {
    const s = (await parseVsCodeFile({ path: MAIN_JSONL, kind: 'jsonl' }, OPTS))!;
    expect(s.id).toBe(MAIN_ID);
    expect(s.title).toBe('Sample parser refactoring');
    expect(s.customTitle).toBe(true);
    expect(s.turns).toHaveLength(3);
    const t0 = s.turns[0]!;
    expect(t0.prompt).toContain('parseJsonLine');
    expect(t0.prompt).toContain('Členů');
    expect(t0.toolCalls.map((t) => t.tool)).toEqual(['copilot_readFile', 'run_in_terminal']);
    expect(t0.toolCalls[1]!.args).toContain('npm test');
    expect(t0.files).toEqual([`${FOLDER}/src/parser.ts`, `${FOLDER}/src/parser-utils.ts`]);
    expect(t0.model).toBe('copilot/claude-sonnet-5.5');
    expect(t0.mode).toBe('Agent');
    expect(t0.promptTokens).toBe(12_000);
    expect(t0.completionTokens).toBe(800);
    expect(t0.credits).toBe(1);
    expect(t0.elapsedMs).toBe(4200);
    expect(t0.thinking).toContain('Placeholder reasoning');
    expect(t0.response).toContain('parseJsonLine');
    expect(t0.response).toContain('parser.ts');
    expect(t0).toMatchObject({ hidden: false, canceled: false, noise: false });
    expect(t0.parts).toBeUndefined();
  });

  it('flags turn 1 as noise + canceled and turn 2 as hidden', async () => {
    const s = (await parseVsCodeFile({ path: MAIN_JSONL, kind: 'jsonl' }, OPTS))!;
    expect(s.turns[1]).toMatchObject({ prompt: 'continue', noise: true, canceled: true, hidden: false });
    expect(s.turns[2]).toMatchObject({ hidden: true, canceled: false, noise: false });
  });

  it('never keeps attachment content, tool output or image bytes (R4.8, R4.9, R4.2)', async () => {
    const s = await parseVsCodeFile({ path: MAIN_JSONL, kind: 'jsonl' }, { ...OPTS, withParts: true });
    const json = JSON.stringify(s);
    expect(json).not.toContain(NEVER_INDEXED);
    expect(json).not.toContain('iVBORw0KGgo');
    expect(json).not.toContain('copilot-instructions.md');
  });

  it('reports diagnostics for unknown kinds and the truncated last line', async () => {
    const s = (await parseVsCodeFile({ path: MAIN_JSONL, kind: 'jsonl' }, OPTS))!;
    expect(s.diagnostics).toMatchObject({ unknownKinds: 1, malformed: 1, oversized: 0 });
  });

  it('parses the byte-identical copy to the same session', async () => {
    const a = await parseVsCodeFile({ path: MAIN_JSONL, kind: 'jsonl' }, OPTS);
    const b = await parseVsCodeFile({ path: MAIN_COPY_JSONL, kind: 'jsonl' }, OPTS);
    expect(b).toEqual(a);
  });

  it('keeps ordered parts for Preview', async () => {
    const s = (await parseVsCodeFile({ path: MAIN_JSONL, kind: 'jsonl' }, { ...OPTS, withParts: true }))!;
    expect(s.turns[0]!.parts!.map((p) => p.kind)).toEqual(['thinking', 'tool', 'tool', 'markdown']);
    const md = s.turns[0]!.parts![3]!;
    expect(md.kind === 'markdown' && md.text).toContain('`parser.ts`');
  });
});

describe('parseVsCodeFile – legacy and empty-window fixtures', () => {
  it('parses a legacy .json as a single snapshot (R4.5)', async () => {
    const s = (await parseVsCodeFile({ path: LEGACY_JSON, kind: 'json' }, OPTS))!;
    expect(s.id).toBe(LEGACY_ID);
    expect(s.turns).toHaveLength(1);
    expect(s.title).toBe('Explain the sample build script.');
    expect(s.customTitle).toBe(false);
    expect(s.turns[0]).toMatchObject({ model: 'copilot/gpt-6.1-sol', mode: 'Agent', elapsedMs: 2100 });
  });

  it('parses the empty-window session', async () => {
    const s = (await parseVsCodeFile({ path: EMPTY_WINDOW_JSONL, kind: 'jsonl' }, OPTS))!;
    expect(s.id).toBe(EMPTY_WINDOW_ID);
    expect(s.turns).toHaveLength(1);
    expect(s.title).toBe('What is a placeholder?');
  });
});

describe('parseVsCodeFile – edge cases', () => {
  it('returns null for an empty file and throws for unparseable or invalid ones', async () => {
    const dir = tempDir();
    const empty = path.join(dir, 'e.jsonl');
    fs.writeFileSync(empty, '');
    expect(await parseVsCodeFile({ path: empty, kind: 'jsonl' }, OPTS)).toBeNull();
    const garbage = path.join(dir, 'g.jsonl');
    fs.writeFileSync(garbage, '{not json');
    await expect(parseVsCodeFile({ path: garbage, kind: 'jsonl' }, OPTS)).rejects.toBeInstanceOf(SessionParseError);
    const badJson = path.join(dir, 'b.json');
    fs.writeFileSync(badJson, '[1,2]');
    await expect(parseVsCodeFile({ path: badJson, kind: 'json' }, OPTS)).rejects.toThrow('unparseable');
    const noRequests = writeJsonl(dir, 'n.jsonl', [{ kind: 0, v: { sessionId: 'x', requests: 'nope' } }]);
    await expect(parseVsCodeFile({ path: noRequests, kind: 'jsonl' }, OPTS)).rejects.toThrow('schema');
  });

  it('rejects a legacy .json larger than the line cap', async () => {
    await expect(parseVsCodeFile({ path: LEGACY_JSON, kind: 'json' }, { ...OPTS, maxLineChars: 100 })).rejects.toThrow('oversized');
  });

  it('falls back to the file name when sessionId is missing', async () => {
    const dir = tempDir();
    const file = writeJsonl(dir, 'abc-123.jsonl', [{ kind: 0, v: { requests: [placeholderRequest(0, 'hello world')] } }]);
    const s = (await parseVsCodeFile({ path: file, kind: 'jsonl' }, OPTS))!;
    expect(s.id).toBe('abc-123');
  });

  it('handles thinking arrays, markdownContent parts, mode fallback, caps and user noise patterns', async () => {
    const dir = tempDir();
    const file = writeJsonl(dir, 's.jsonl', [
      { kind: 0, v: { sessionId: 's1', creationDate: 5, inputState: { mode: { id: 'ask' } }, requests: [] } },
      {
        kind: 2,
        k: ['requests'],
        v: [
          placeholderRequest(0, 'pokračuj'),
          placeholderRequest(1, 'Explain the placeholder module please', {
            response: [
              { kind: 'thinking', value: ['first thought', 42, 'second thought'] },
              { kind: 'markdownContent', content: { value: 'markdown content part ' } },
              { value: 'x'.repeat(200) },
              { kind: 'inlineReference', inlineReference: { uri: { fsPath: '/w/src/mod.ts' }, range: {} } },
              { kind: 'inlineReference', inlineReference: { name: 'symbolName' } },
              { kind: 'unknownPart', value: 'ignored' },
              null,
            ],
            modeInfo: { kind: 'ask' },
            contentReferences: [{ reference: 'file:///w/readme.md' }, { reference: { uri: { fsPath: '/w/a.ts' } } }, 'bad'],
            variableData: { variables: [{ kind: 'file', value: 'file:///w/b.ts' }, null] },
            result: { timings: { totalElapsed: 99 } },
            modelState: { value: 1 },
            isSystemInitiated: false,
          }),
        ],
      },
    ]);
    const s = (await parseVsCodeFile({ path: file, kind: 'jsonl' }, { maxFieldChars: 50, isNoise: createNoiseMatcher(['pokračuj']), withParts: true }))!;
    const [t0, t1] = s.turns;
    expect(t0!.noise).toBe(true);
    expect(t0!.mode).toBe('ask');
    expect(s.title).toBe('Explain the placeholder module please');
    expect(t1!.thinking).toBe('first thought\nsecond thought');
    expect(t1!.response.startsWith('markdown content part x')).toBe(true);
    expect(t1!.response).toHaveLength(50);
    expect(t1!.files.sort()).toEqual(['/w/a.ts', '/w/b.ts', '/w/readme.md']);
    expect(t1!.elapsedMs).toBe(99);
    expect(t1!.mode).toBe('ask');
    const md = t1!.parts!.find((p) => p.kind === 'markdown');
    expect(md && md.kind === 'markdown' && md.text).toContain('`mod.ts`');
    expect(md && md.kind === 'markdown' && md.text).toContain('`symbolName`');
  });

  it('marks isSystemInitiated turns as hidden', () => {
    const s = mapVsCodeSession({ sessionId: 'x', requests: [placeholderRequest(0, 'auto', { isSystemInitiated: true }) as never] }, 'x', OPTS)!;
    expect(s.turns[0]!.hidden).toBe(true);
    expect(s.title).toBe('');
  });
});

describe('prune on replay (R4.13)', () => {
  const stateWith = (part: Record<string, JsonValue>): JsonValue => ({ requests: [{ response: [part] }] });

  it('keeps kind-1 updates of markdown parts (spike regression)', () => {
    const e = { kind: 1, k: ['requests', 0, 'response', 0, 'value'], v: 'text' };
    expect(pruneVsCodeEntry(e, stateWith({ value: '' }))).toBe(true);
    expect(e.v).toBe('text');
  });

  it('skips tool output updates and reduces toolSpecificData to the command line', () => {
    const tool = { kind: 'toolInvocationSerialized', toolId: 't' };
    expect(pruneVsCodeEntry({ kind: 1, k: ['requests', 0, 'response', 0, 'resultDetails'], v: { big: 1 } }, stateWith(tool))).toBe(false);
    expect(pruneVsCodeEntry({ kind: 1, k: ['requests', 0, 'response', 0, 'isComplete'], v: true }, stateWith(tool))).toBe(true);
    const tsd = { kind: 1, k: ['requests', 0, 'response', 0, 'toolSpecificData'], v: { kind: 'terminal', commandLine: { original: 'ls' }, output: 'x' } as JsonValue };
    expect(pruneVsCodeEntry(tsd, stateWith(tool))).toBe(true);
    expect(tsd.v).toEqual({ kind: 'terminal', commandLine: { original: 'ls' } });
    expect(pruneVsCodeEntry({ kind: 1, k: ['requests', 0, 'response', 0, 'toolSpecificData', 'commandLine'], v: 'ls' }, stateWith(tool))).toBe(true);
    expect(pruneVsCodeEntry({ kind: 1, k: ['requests', 0, 'response', 0, 'toolSpecificData', 'output'], v: 'x' }, stateWith(tool))).toBe(false);
  });

  it('prunes whole requests, response arrays, single parts and result metadata', () => {
    const part = (): Record<string, JsonValue> => ({ kind: 'toolInvocationSerialized', toolId: 't', resultDetails: { x: 1 }, toolSpecificData: { other: 1 } });
    const req = (): Record<string, JsonValue> => ({ response: [part()], result: { metadata: { m: 1 }, details: 'd' } });
    const e0 = { kind: 0, v: { requests: [req()] } as JsonValue };
    pruneVsCodeEntry(e0, {});
    expect(e0.v).toEqual({ requests: [{ response: [{ kind: 'toolInvocationSerialized', toolId: 't', toolSpecificData: null }], result: { details: 'd' } }] });
    const e1 = { kind: 2, k: ['requests'], v: [req()] as JsonValue };
    pruneVsCodeEntry(e1, {});
    expect(JSON.stringify(e1.v)).not.toContain('resultDetails');
    const e2 = { kind: 1, k: ['requests', 0], v: req() as JsonValue };
    pruneVsCodeEntry(e2, {});
    expect(JSON.stringify(e2.v)).not.toContain('metadata');
    const e3 = { kind: 2, k: ['requests', 0, 'response'], v: [part()] as JsonValue };
    pruneVsCodeEntry(e3, {});
    expect(JSON.stringify(e3.v)).not.toContain('resultDetails');
    const e4 = { kind: 1, k: ['requests', 0, 'response', 0], v: part() as JsonValue };
    pruneVsCodeEntry(e4, {});
    expect(JSON.stringify(e4.v)).not.toContain('resultDetails');
    const e5 = { kind: 1, k: ['requests', 0, 'result'], v: { metadata: 1, ok: 2 } as JsonValue };
    pruneVsCodeEntry(e5, {});
    expect(e5.v).toEqual({ ok: 2 });
    expect(pruneVsCodeEntry({ kind: 1, k: ['requests', 0, 'result', 'metadata'], v: 1 }, {})).toBe(false);
    expect(pruneVsCodeEntry({ kind: 1, k: ['requests', 0, 'result', 'timings'], v: 1 }, {})).toBe(true);
    expect(pruneVsCodeEntry({ kind: 1, k: ['customTitle'], v: 't' }, {})).toBe(true);
    expect(pruneVsCodeEntry({ kind: 1, k: ['requests', 0, 'modelState'], v: 1 }, {})).toBe(true);
  });
});

describe('preStripHeavy (R4.13)', () => {
  it('leaves short lines untouched', () => {
    const line = '{"resultDetails":{"a":1}}';
    expect(preStripHeavy(line)).toBe(line);
  });

  it('nulls heavy object/array values in long lines, string-aware', () => {
    const big = 'z'.repeat(300 * 1024);
    const line = JSON.stringify({ kind: 1, v: { toolSpecificData: { s: '}{', big }, resultDetails: [big], metadata: 'scalar', text: '"metadata": {' } });
    const out = JSON.parse(preStripHeavy(line)) as { v: Record<string, unknown> };
    expect(out.v).toEqual({ toolSpecificData: null, resultDetails: null, metadata: 'scalar', text: '"metadata": {' });
  });

  it('returns the line unchanged when nothing matches', () => {
    const line = JSON.stringify({ text: 'q'.repeat(300 * 1024) });
    expect(preStripHeavy(line)).toBe(line);
  });
});

describe('deriveTitle and parser registry', () => {
  it('skips hidden, noise and empty prompts and truncates to 80 chars', () => {
    const long = 'word '.repeat(40);
    expect(deriveTitle([{ prompt: 'x', hidden: true, noise: false }, { prompt: ' ', hidden: false, noise: false }, { prompt: long, hidden: false, noise: false }])).toHaveLength(80);
  });

  it('finds the vscode parser for both VS Code sources', () => {
    expect(parserFor({ path: 'a', source: 'vscode', kind: 'jsonl' })).toBe(vscodeParser);
    expect(parserFor({ path: 'a', source: 'vscode-insiders', kind: 'json' })).toBe(vscodeParser);
    expect(parserFor({ path: 'a', source: 'copilot-cli', kind: 'jsonl' })?.id).toBe('copilot-cli');
    expect(parserSignature()).toMatch(/^vscode@\d+,copilot-cli@\d+$/);
  });

  it('parses through the registry', async () => {
    const s = await vscodeParser.parse({ path: LEGACY_JSON, source: 'vscode', kind: 'json' }, OPTS);
    expect(s?.id).toBe(LEGACY_ID);
  });
});
