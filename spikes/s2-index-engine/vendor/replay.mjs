// Changes: plain JS, no prefetch cache / trusted-path checks, reconstruct is async (stream replay),
// unknown kinds are counted, files opened read-only.

import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

const JSONL_READ_CHUNK = 1024 * 1024;
const JSONL_YIELD_BYTES = 16 * 1024 * 1024;

function emitChunkLines(pending, chunk, onLine) {
  let newline = chunk.indexOf('\n');
  if (newline < 0) return pending + chunk;
  onLine(pending + chunk.slice(0, newline));
  let start = newline + 1;
  newline = chunk.indexOf('\n', start);
  while (newline >= 0) {
    onLine(chunk.slice(start, newline));
    start = newline + 1;
    newline = chunk.indexOf('\n', start);
  }
  return chunk.slice(start);
}

export async function forEachJsonlLineAsync(fpath, onLine) {
  const fd = fs.openSync(fpath, 'r');
  try {
    const decoder = new StringDecoder('utf8');
    const buffer = Buffer.allocUnsafe(JSONL_READ_CHUNK);
    let pending = '';
    let sinceYield = 0;
    let bytesRead;
    while ((bytesRead = fs.readSync(fd, buffer, 0, JSONL_READ_CHUNK, null)) > 0) {
      sinceYield += bytesRead;
      pending = emitChunkLines(pending, decoder.write(buffer.subarray(0, bytesRead)), onLine);
      if (sinceYield >= JSONL_YIELD_BYTES) {
        sinceYield = 0;
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    pending += decoder.end();
    if (pending.length > 0) onLine(pending);
  } finally {
    fs.closeSync(fd);
  }
}

export function skipQuotedString(raw, start) {
  let i = start + 1;
  while (i < raw.length) {
    if (raw[i] === '\\') { i += 2; continue; }
    if (raw[i] === '"') return i + 1;
    i++;
  }
  return i;
}

export function consumeBalancedObject(raw, start) {
  let depth = 1;
  let i = start + 1;
  while (i < raw.length && depth > 0) {
    const ch = raw[i];
    if (ch === '{') { depth++; i++; continue; }
    if (ch === '}') { depth--; i++; continue; }
    if (ch === '"') { i = skipQuotedString(raw, i); continue; }
    i++;
  }
  return i;
}

function stripByteArrayImages(raw) {
  if (!raw.includes('[255,216,255') && !raw.includes('[137,80,78,71')) return raw;
  return raw.replaceAll(/"data":\[(255,216,255|137,80,78,71)[0-9,]*\]/g, '"data":[]');
}

export function stripImageData(raw) {
  raw = stripByteArrayImages(raw);
  if (!raw.includes('"image"')) return raw;
  const parts = [];
  let lastEnd = 0;
  const kindRe = /"kind"\s*:\s*"image"/g;
  let m;
  while ((m = kindRe.exec(raw)) !== null) {
    const searchStart = m.index + m[0].length;
    const valMatch = raw.slice(searchStart, searchStart + 200).match(/"value"\s*:/);
    if (!valMatch || valMatch.index === undefined) continue;
    let valStart = searchStart + valMatch.index + valMatch[0].length;
    while (valStart < raw.length && ' \t\n\r'.includes(raw[valStart])) valStart++;
    if (raw[valStart] !== '{') continue;
    parts.push(raw.slice(lastEnd, valStart));
    parts.push('"[stripped]"');
    lastEnd = consumeBalancedObject(raw, valStart);
  }
  if (parts.length === 0) return raw;
  parts.push(raw.slice(lastEnd));
  return parts.join('');
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const isForbiddenKey = (key) => typeof key === 'string' && FORBIDDEN_KEYS.has(key);
const MAX_PATCH_INDEX = 1_000_000;
const MAX_PATCH_KEYS = 1024;
const hasUnsafePathKeys = (keys) => keys.length > MAX_PATCH_KEYS || keys.some((key) =>
  typeof key === 'number' && (!Number.isInteger(key) || key < 0 || key > MAX_PATCH_INDEX));

function setAtPath(obj, keys, value) {
  if (hasUnsafePathKeys(keys)) return;
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (isForbiddenKey(key)) return;
    if (typeof key === 'number' && Array.isArray(current)) {
      while (current.length <= key) current.push(null);
      if (current[key] === null) current[key] = {};
      current = current[key];
    } else if (typeof current === 'object' && current !== null && !Array.isArray(current)) {
      if (!Object.prototype.hasOwnProperty.call(current, key)) current[key] = {};
      current = current[key];
    }
  }
  const last = keys[keys.length - 1];
  if (isForbiddenKey(last)) return;
  if (Array.isArray(current)) {
    while (current.length <= last) current.push(null);
    current[last] = value;
  } else if (typeof current === 'object' && current !== null) {
    current[last] = value;
  }
}

function appendAtPath(obj, keys, items) {
  if (hasUnsafePathKeys(keys)) return;
  let target = obj;
  for (const key of keys) {
    if (isForbiddenKey(key)) return;
    if (typeof key === 'number' && Array.isArray(target)) {
      target = target[key];
    } else if (typeof target === 'object' && target !== null && !Array.isArray(target)) {
      if (!Object.prototype.hasOwnProperty.call(target, key)) target[key] = [];
      target = target[key];
    }
  }
  if (Array.isArray(target) && Array.isArray(items)) target.push(...items);
}

/** Stream-replays a VS Code chat `.jsonl` mutation log. `stats` collects kind counts.
 *  Searchie additions: `prune(entry)` may shrink `entry.v` before it is applied, so heavy fields never accumulate;
 *  `preStrip(line)` may drop heavy values at string level before JSON.parse. */
export async function reconstructFromJsonlAsync(fpath, stats = {}, prune, preStrip) {
  let state = {};
  let initialModeId;
  await forEachJsonlLineAsync(fpath, (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const entry = JSON.parse(stripImageData(preStrip ? preStrip(trimmed) : trimmed));
      stats[`kind${entry.kind}`] = (stats[`kind${entry.kind}`] || 0) + 1;
      prune?.(entry);
      if (entry.kind === 0) {
        state = entry.v || {};
        const mode = state.inputState?.mode;
        if (typeof mode?.id === 'string') initialModeId = mode.id;
      } else if (entry.kind === 1) {
        setAtPath(state, entry.k || [], entry.v);
      } else if (entry.kind === 2) {
        appendAtPath(state, entry.k || [], entry.v);
      }
    } catch {
      stats.malformed = (stats.malformed || 0) + 1;
    }
  });
  if (Object.keys(state).length === 0) return null;
  if (initialModeId && state.inputState && typeof state.inputState === 'object') {
    state.inputState.mode = { id: initialModeId };
  }
  return state;
}
