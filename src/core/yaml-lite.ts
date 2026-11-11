/**
 * Minimal reader for flat YAML maps such as Copilot CLI `workspace.yaml` (SPEC R4.15): top-level `key: value`
 * pairs with plain, single-quoted or double-quoted scalars. Nested, multi-line, block, flow and aliased values
 * are ignored. Not a general YAML parser.
 */

const KEY_LINE = /^([A-Za-z_][\w.-]*)[ \t]*:(?:[ \t]+(.*))?$/;
const NULLS = new Set(['', '~', 'null', 'Null', 'NULL']);

const SIMPLE_ESCAPES: Record<string, string> = {
  '0': '\0',
  a: '\x07',
  b: '\b',
  t: '\t',
  '\t': '\t',
  n: '\n',
  v: '\v',
  f: '\f',
  r: '\r',
  e: '\x1b',
  ' ': ' ',
  '"': '"',
  '/': '/',
  '\\': '\\',
  N: '\u0085',
  _: '\u00a0',
  L: '\u2028',
  P: '\u2029',
};

function doubleQuoted(raw: string): string | undefined {
  let out = '';
  for (let i = 1; i < raw.length; i++) {
    const c = raw[i]!;
    if (c === '"') {
      const rest = raw.slice(i + 1).trim();
      return rest === '' || rest.startsWith('#') ? out : undefined;
    }
    if (c !== '\\') {
      out += c;
      continue;
    }
    const e = raw[++i];
    if (e === undefined) return undefined;
    const hexLen = e === 'x' ? 2 : e === 'u' ? 4 : e === 'U' ? 8 : 0;
    if (hexLen) {
      const hex = raw.slice(i + 1, i + 1 + hexLen);
      if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== hexLen) return undefined;
      const cp = Number.parseInt(hex, 16);
      if (cp > 0x10ffff) return undefined;
      out += String.fromCodePoint(cp);
      i += hexLen;
    } else if (e in SIMPLE_ESCAPES) {
      out += SIMPLE_ESCAPES[e];
    } else {
      return undefined;
    }
  }
  return undefined;
}

function singleQuoted(raw: string): string | undefined {
  let out = '';
  for (let i = 1; i < raw.length; i++) {
    const c = raw[i]!;
    if (c !== "'") {
      out += c;
      continue;
    }
    if (raw[i + 1] === "'") {
      out += "'";
      i++;
      continue;
    }
    const rest = raw.slice(i + 1).trim();
    return rest === '' || rest.startsWith('#') ? out : undefined;
  }
  return undefined;
}

function plain(raw: string): string | undefined {
  const v = raw.replace(/[ \t]+#.*$/, '').trim();
  if (NULLS.has(v)) return undefined;
  // Block scalars, flow collections, anchors, aliases, tags and document markers are not supported.
  if (/^[|>[{&*!%@`]/.test(v)) return undefined;
  return v;
}

/** Parses flat top-level scalars; unsupported values are skipped. Keys are case-sensitive. */
export function parseFlatYaml(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = KEY_LINE.exec(line);
    if (!m) continue;
    const raw = (m[2] ?? '').trim();
    const value = raw.startsWith('"') ? doubleQuoted(raw) : raw.startsWith("'") ? singleQuoted(raw) : plain(raw);
    if (value !== undefined && !out.has(m[1]!)) out.set(m[1]!, value);
  }
  return out;
}
