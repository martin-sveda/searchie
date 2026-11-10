import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAIN_JSONL, tempDir, writeJsonl } from '../../test/helpers';
import {
  appendAtPath,
  consumeBalanced,
  emptyReplayStats,
  forEachJsonlLineAsync,
  isUnsafePath,
  type JsonValue,
  reconstructFromJsonlAsync,
  setAtPath,
  stripImageData,
} from './replay';

describe('reconstructFromJsonlAsync on the main fixture', () => {
  it('counts kinds, unknown kinds and the truncated last line (R4.4)', async () => {
    const stats = emptyReplayStats();
    const state = await reconstructFromJsonlAsync(MAIN_JSONL, { stats });
    expect(state).not.toBeNull();
    expect(stats.kinds).toEqual({ '0': 1, '1': 12, '2': 12, '7': 1 });
    expect(stats.unknownKinds).toBe(1);
    expect(stats.malformed).toBe(1);
    expect(stats.lines).toBe(27);
  });

  it('rejects prototype-pollution paths (R4.3)', async () => {
    const state = (await reconstructFromJsonlAsync(MAIN_JSONL)) as Record<string, unknown>;
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(state, 'polluted')).toBe(false);
    const requests = state.requests as Record<string, unknown>[];
    expect(Object.prototype.hasOwnProperty.call(requests[0], 'constructor')).toBe(false);
    expect((Object as unknown as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('returns null for an empty file', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'empty.jsonl');
    fs.writeFileSync(file, '');
    expect(await reconstructFromJsonlAsync(file)).toBeNull();
  });

  it('applies the prune hook and skips entries it rejects', async () => {
    const dir = tempDir();
    const file = writeJsonl(dir, 's.jsonl', [
      { kind: 0, v: { sessionId: 's', requests: [] } },
      { kind: 1, k: ['skipMe'], v: 1 },
      { kind: 1, k: ['keep'], v: 2 },
    ]);
    const state = await reconstructFromJsonlAsync(file, { prune: (e) => e.k?.[0] !== 'skipMe' });
    expect(state).toEqual({ sessionId: 's', requests: [], keep: 2 });
  });

  it('treats non-object lines and invalid k as malformed', async () => {
    const dir = tempDir();
    const file = writeJsonl(dir, 's.jsonl', [{ kind: 0, v: { a: 1 } }, [1, 2], { kind: 1, k: 'x', v: 1 }, { nokind: true }]);
    const stats = emptyReplayStats();
    await reconstructFromJsonlAsync(file, { stats });
    expect(stats.malformed).toBe(3);
  });

  it('restores the initial input mode id', async () => {
    const dir = tempDir();
    const file = writeJsonl(dir, 's.jsonl', [
      { kind: 0, v: { inputState: { mode: { id: 'ask' } } } },
      { kind: 1, k: ['inputState', 'mode'], v: { id: 'agent', extra: 1 } },
    ]);
    const state = (await reconstructFromJsonlAsync(file)) as { inputState: { mode: unknown } };
    expect(state.inputState.mode).toEqual({ id: 'ask' });
  });
});

describe('forEachJsonlLineAsync', () => {
  it('skips lines longer than the cap without losing the following lines (R4.14)', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'big.jsonl');
    const long = 'x'.repeat(3 * 1024 * 1024);
    fs.writeFileSync(file, `short1\n${long}\nshort2\n${long}`);
    const lines: string[] = [];
    let oversized = 0;
    await forEachJsonlLineAsync(file, (l) => lines.push(l), 1024, () => oversized++);
    expect(lines).toEqual(['short1', 'short2']);
    expect(oversized).toBe(2);
  });

  it('handles multi-byte characters split across chunks', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'utf8.jsonl');
    const text = 'Členů '.repeat(400_000);
    fs.writeFileSync(file, `${text}\nend`);
    const lines: string[] = [];
    await forEachJsonlLineAsync(file, (l) => lines.push(l));
    expect(lines).toEqual([text, 'end']);
  });

  it('counts an oversized line in replay stats as malformed', async () => {
    const dir = tempDir();
    const file = writeJsonl(dir, 's.jsonl', [{ kind: 0, v: { a: 1 } }], [JSON.stringify({ kind: 1, k: ['b'], v: 'y'.repeat(5000) })]);
    const stats = emptyReplayStats();
    const state = await reconstructFromJsonlAsync(file, { stats, maxLineChars: 1000 });
    expect(state).toEqual({ a: 1 });
    expect(stats.oversized).toBe(1);
    expect(stats.malformed).toBe(1);
  });
});

describe('setAtPath / appendAtPath', () => {
  it('creates intermediate objects and pads arrays', () => {
    const obj: JsonValue = { requests: [] };
    setAtPath(obj, ['requests', 2, 'x'], 1);
    expect(obj).toEqual({ requests: [null, null, { x: 1 }] });
  });

  it('ignores unsafe and mismatched paths', () => {
    const obj: JsonValue = { a: [1] };
    setAtPath(obj, ['a', -1], 2);
    setAtPath(obj, ['a', 1.5], 2);
    setAtPath(obj, ['a', 2_000_000], 2);
    setAtPath(obj, [], 2);
    setAtPath(obj, ['a', 'x', 'y'], 2);
    setAtPath(obj, ['__proto__', 'p'], 2);
    appendAtPath(obj, ['prototype'], [1]);
    appendAtPath(obj, ['a'], 'notArray');
    appendAtPath(obj, ['a', 'nope'], [1]);
    expect(obj).toEqual({ a: [1] });
  });

  it('appends to existing and new arrays', () => {
    const obj: JsonValue = { list: [{ items: [1] }] };
    appendAtPath(obj, ['list', 0, 'items'], [2, 3]);
    appendAtPath(obj, ['fresh'], [4]);
    expect(obj).toEqual({ list: [{ items: [1, 2, 3] }], fresh: [4] });
  });

  it('flags unsafe paths', () => {
    expect(isUnsafePath(['a', 0])).toBe(false);
    expect(isUnsafePath(['constructor'])).toBe(true);
    expect(isUnsafePath([{}])).toBe(true);
    expect(isUnsafePath(new Array(2000).fill('a'))).toBe(true);
  });
});

describe('stripImageData / consumeBalanced', () => {
  it('drops PNG/JPEG byte arrays and image values', () => {
    expect(stripImageData('{"data":[137,80,78,71,1,2,3]}')).toBe('{"data":[]}');
    expect(stripImageData('{"data":[255,216,255,9]}')).toBe('{"data":[]}');
    const raw = '{"kind":"image","value":{"data":"AAAA","nested":{"q":"}"}},"after":1}';
    expect(JSON.parse(stripImageData(raw))).toEqual({ kind: 'image', value: '[stripped]', after: 1 });
    expect(stripImageData('{"kind":"image","value":"str"}')).toBe('{"kind":"image","value":"str"}');
    expect(stripImageData('{"no":"images"}')).toBe('{"no":"images"}');
  });

  it('is string-aware when balancing', () => {
    const raw = '{"a":"}]\\"{","b":[1,{"c":2}]}rest';
    expect(raw.slice(consumeBalanced(raw, 0))).toBe('rest');
  });
});
