/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See THIRD_PARTY_NOTICES.md in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Adapted from Searchie prototype: src/core/parser-vscode-files.ts
// (forEachJsonlLineAsync, stripImageData, setAtPath, appendAtPath, reconstructFromJsonl)
// Changes for Searchie: streaming replay is async; files are opened read-only; lines longer than
// `maxLineChars` are skipped without being buffered (R4.14); unknown kinds are counted (R4.4);
// optional `preStrip` (string level) and `prune` (after JSON.parse) hooks keep memory bounded (R4.13).

import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

const JSONL_READ_CHUNK = 1024 * 1024;
const JSONL_YIELD_BYTES = 16 * 1024 * 1024;

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type PathKey = string | number;

export interface ReplayStats {
  lines: number;
  malformed: number;
  oversized: number;
  unknownKinds: number;
  kinds: Record<string, number>;
}

export function emptyReplayStats(): ReplayStats {
  return { lines: 0, malformed: 0, oversized: 0, unknownKinds: 0, kinds: {} };
}

/**
 * Streams a file line by line in 1 MB chunks (R4.1). A line longer than `maxLineChars` is dropped as
 * soon as it exceeds the cap, so it is never held in memory as a whole; `onOversized` is called once per line.
 */
export async function forEachJsonlLineAsync(
  fpath: string,
  onLine: (line: string) => void,
  maxLineChars = Number.POSITIVE_INFINITY,
  onOversized?: () => void,
): Promise<void> {
  const handle = await fs.promises.open(fpath, 'r');
  try {
    const decoder = new StringDecoder('utf8');
    const buffer = Buffer.allocUnsafe(JSONL_READ_CHUNK);
    let pending: string[] = [];
    let pendingLength = 0;
    let skipping = false;
    let sinceYield = 0;

    const pushPartial = (part: string): void => {
      if (skipping || part.length === 0) return;
      if (pendingLength + part.length > maxLineChars) {
        skipping = true;
        pending = [];
        pendingLength = 0;
        onOversized?.();
        return;
      }
      pending.push(part);
      pendingLength += part.length;
    };
    const endLine = (): void => {
      if (!skipping) onLine(pending.length === 1 ? pending[0]! : pending.join(''));
      pending = [];
      pendingLength = 0;
      skipping = false;
    };
    const feed = (chunk: string): void => {
      let start = 0;
      let newline = chunk.indexOf('\n', start);
      while (newline >= 0) {
        pushPartial(chunk.slice(start, newline));
        endLine();
        start = newline + 1;
        newline = chunk.indexOf('\n', start);
      }
      pushPartial(chunk.slice(start));
    };

    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, JSONL_READ_CHUNK, null);
      if (bytesRead <= 0) break;
      feed(decoder.write(buffer.subarray(0, bytesRead)));
      sinceYield += bytesRead;
      if (sinceYield >= JSONL_YIELD_BYTES) {
        sinceYield = 0;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    feed(decoder.end());
    if (pendingLength > 0) endLine();
  } finally {
    await handle.close();
  }
}

export function skipQuotedString(raw: string, start: number): number {
  let i = start + 1;
  while (i < raw.length) {
    if (raw[i] === '\\') {
      i += 2;
      continue;
    }
    if (raw[i] === '"') return i + 1;
    i++;
  }
  return i;
}

/** Returns the index after the object or array that opens at `start` (string-aware). */
export function consumeBalanced(raw: string, start: number): number {
  let depth = 1;
  let i = start + 1;
  while (i < raw.length && depth > 0) {
    const ch = raw[i];
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
    else if (ch === '"') {
      i = skipQuotedString(raw, i);
      continue;
    }
    i++;
  }
  return i;
}

function stripByteArrayImages(raw: string): string {
  if (!raw.includes('[255,216,255') && !raw.includes('[137,80,78,71')) return raw;
  return raw.replaceAll(/"data":\[(255,216,255|137,80,78,71)[0-9,]*\]/g, '"data":[]');
}

/** Drops embedded image payloads before JSON.parse (R4.2). */
export function stripImageData(raw: string): string {
  raw = stripByteArrayImages(raw);
  if (!raw.includes('"image"')) return raw;
  const parts: string[] = [];
  let lastEnd = 0;
  const kindRe = /"kind"\s*:\s*"image"/g;
  let m: RegExpExecArray | null;
  while ((m = kindRe.exec(raw)) !== null) {
    const searchStart = m.index + m[0].length;
    const valMatch = /"value"\s*:/.exec(raw.slice(searchStart, searchStart + 200));
    if (!valMatch) continue;
    let valStart = searchStart + valMatch.index + valMatch[0].length;
    while (valStart < raw.length && ' \t\n\r'.includes(raw[valStart]!)) valStart++;
    if (raw[valStart] !== '{') continue;
    parts.push(raw.slice(lastEnd, valStart), '"[stripped]"');
    lastEnd = consumeBalanced(raw, valStart);
    kindRe.lastIndex = Math.max(kindRe.lastIndex, lastEnd);
  }
  if (parts.length === 0) return raw;
  parts.push(raw.slice(lastEnd));
  return parts.join('');
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_PATCH_INDEX = 1_000_000;
const MAX_PATCH_KEYS = 1024;

/** R4.3 – rejects forbidden segments and out-of-range or non-integer numeric segments. */
export function isUnsafePath(keys: readonly unknown[]): boolean {
  if (keys.length > MAX_PATCH_KEYS) return true;
  return keys.some(
    (key) =>
      (typeof key !== 'string' && typeof key !== 'number') ||
      (typeof key === 'string' && FORBIDDEN_KEYS.has(key)) ||
      (typeof key === 'number' && (!Number.isInteger(key) || key < 0 || key > MAX_PATCH_INDEX)),
  );
}

const isObject = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);

export function setAtPath(obj: JsonValue, keys: readonly PathKey[], value: JsonValue): void {
  if (keys.length === 0 || isUnsafePath(keys)) return;
  let current: JsonValue = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]!;
    if (typeof key === 'number' && Array.isArray(current)) {
      while (current.length <= key) current.push(null);
      if (current[key] === null) current[key] = {};
      current = current[key]!;
    } else if (typeof key === 'string' && isObject(current)) {
      if (!Object.prototype.hasOwnProperty.call(current, key)) current[key] = {};
      current = current[key]!;
    } else {
      return;
    }
  }
  const last = keys[keys.length - 1]!;
  if (Array.isArray(current) && typeof last === 'number') {
    while (current.length <= last) current.push(null);
    current[last] = value;
  } else if (isObject(current) && typeof last === 'string') {
    current[last] = value;
  }
}

export function appendAtPath(obj: JsonValue, keys: readonly PathKey[], items: JsonValue): void {
  if (isUnsafePath(keys) || !Array.isArray(items)) return;
  let target: JsonValue | undefined = obj;
  for (const key of keys) {
    if (typeof key === 'number' && Array.isArray(target)) {
      target = target[key];
    } else if (typeof key === 'string' && isObject(target)) {
      if (!Object.prototype.hasOwnProperty.call(target, key)) target[key] = [];
      target = target[key];
    } else {
      return;
    }
  }
  if (Array.isArray(target)) for (const item of items) target.push(item);
}

export interface ReplayEntry {
  kind: number;
  k?: PathKey[];
  v?: JsonValue;
}

export interface ReplayOptions {
  /** Called after JSON.parse; may shrink `entry.v`. Returning false skips the entry (R4.13). */
  prune?: (entry: ReplayEntry, state: JsonValue) => boolean;
  /** Called on the raw line before JSON.parse (R4.13 string-level strip of very long lines). */
  preStrip?: (line: string) => string;
  maxLineChars?: number;
  stats?: ReplayStats;
}

function parseEntry(line: string, options: ReplayOptions, stats: ReplayStats): ReplayEntry | null {
  try {
    const parsed: unknown = JSON.parse(stripImageData(options.preStrip ? options.preStrip(line) : line));
    if (isObject(parsed) && typeof parsed.kind === 'number' && (parsed.k === undefined || Array.isArray(parsed.k))) {
      return parsed as unknown as ReplayEntry;
    }
  } catch {
    // counted below
  }
  stats.malformed++;
  return null;
}

/** Stream-replays a VS Code chat `.jsonl` mutation log (kind 0 snapshot, 1 set, 2 append). */
export async function reconstructFromJsonlAsync(fpath: string, options: ReplayOptions = {}): Promise<JsonObject | null> {
  const stats = options.stats ?? emptyReplayStats();
  let state: JsonValue = {};
  let initialModeId: string | undefined;
  await forEachJsonlLineAsync(
    fpath,
    (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      stats.lines++;
      const entry = parseEntry(trimmed, options, stats);
      if (!entry) return;
      stats.kinds[String(entry.kind)] = (stats.kinds[String(entry.kind)] ?? 0) + 1;
      if (entry.kind !== 0 && entry.kind !== 1 && entry.kind !== 2) {
        stats.unknownKinds++;
        return;
      }
      if (options.prune && !options.prune(entry, state)) return;
      if (entry.kind === 0) {
        state = isObject(entry.v) ? entry.v : {};
        const mode = isObject(state.inputState) ? state.inputState.mode : undefined;
        if (isObject(mode) && typeof mode.id === 'string') initialModeId = mode.id;
      } else if (entry.kind === 1) {
        setAtPath(state, entry.k ?? [], entry.v ?? null);
      } else {
        appendAtPath(state, entry.k ?? [], entry.v ?? null);
      }
    },
    options.maxLineChars,
    () => {
      stats.lines++;
      stats.oversized++;
      stats.malformed++;
    },
  );
  if (!isObject(state) || Object.keys(state).length === 0) return null;
  if (initialModeId && isObject(state.inputState)) state.inputState.mode = { id: initialModeId };
  return state;
}
