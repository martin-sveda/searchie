/** Text processing for indexing (SPEC §5.4). */

const NOISE_PHRASE = /^(?:@agent\s+)?(?:continue|try again|retry|stop|cancel|abort)[\s.!?:]*$/i;
const NOISE_YES_NO = /^(?:y|n|yes|no)[\s.!?]*$/i;
const SHORT_CONFIRM = /^[yYnN.!?]+$/;

/**
 * Builds the R5.10 noise predicate. Rules derived from the Searchie prototype `isNoise` concept (not copied code);
 * unlike Searchie prototype, long prompts are not noise. `userPatterns` are case-insensitive regexes matched
 * against the whole trimmed prompt; invalid ones are reported through `onInvalid` and ignored.
 */
export function createNoiseMatcher(userPatterns: readonly string[] = [], onInvalid?: (pattern: string) => void): (prompt: string) => boolean {
  const extra: RegExp[] = [];
  for (const p of userPatterns) {
    if (typeof p !== 'string' || !p.trim()) continue;
    try {
      extra.push(new RegExp(`^(?:${p})$`, 'iu'));
    } catch {
      onInvalid?.(p);
    }
  }
  return (prompt: string): boolean => {
    const t = prompt.trim();
    if (!t) return false;
    if (NOISE_PHRASE.test(t) || NOISE_YES_NO.test(t)) return true;
    if (t.length < 80 && /continue to iterate/i.test(t)) return true;
    if (t.length <= 3 && SHORT_CONFIRM.test(t)) return true;
    if (/^system/i.test(t)) return true;
    return extra.some((re) => re.test(t));
  };
}

export const isNoise = createNoiseMatcher();

const IDENT_RE = /[A-Za-z][A-Za-z0-9]*(?:[A-Z_][a-z0-9]+)+/g;
const MAX_IDENTIFIERS = 2000;

/** R5.7 – split camelCase / PascalCase / snake_case identifiers into lower-case parts (unique identifiers only). */
export function identifierParts(text: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(IDENT_RE)) {
    const ident = m[0];
    if (seen.has(ident)) continue;
    seen.add(ident);
    out.push(
      ident
        .replaceAll('_', ' ')
        .replaceAll(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replaceAll(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .toLowerCase()
        .trim(),
    );
    if (out.length >= MAX_IDENTIFIERS) break;
  }
  return out.join(' ');
}

/** R5.8 – full path + basename + basename without extension, per unique path. */
export function expandPaths(paths: readonly string[]): string {
  const out: string[] = [];
  for (const p of new Set(paths)) {
    if (!p) continue;
    const base = p.split(/[\\/]/).pop() || p;
    const stem = base.replace(/\.[^.]+$/, '');
    out.push(p, base);
    if (stem && stem !== base) out.push(stem);
  }
  return out.join(' ');
}

/** Truncates to at most `maxChars` UTF-16 units without splitting a surrogate pair (R4.10). */
export function capText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let end = Math.max(0, maxChars);
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return text.slice(0, end);
}

/** Collapses whitespace and truncates to `max` chars with an ellipsis (session titles). */
export function oneLine(text: string, max = 80): string {
  const t = text.replaceAll(/\s+/g, ' ').trim();
  return t.length > max ? `${capText(t, max - 1)}…` : t;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Adapted concept from Searchie prototype `fileUriToPath`: `file:///C:/x` → `C:/x`, `file:///home/u` → `/home/u`. */
export function fileUriToPath(raw: string): string {
  if (!raw.startsWith('file://')) return raw;
  let p = safeDecode(raw.slice('file://'.length));
  if (p.startsWith('/') === false) {
    // UNC: file://server/share → //server/share
    p = `//${p}`;
  }
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
  return p;
}

/** Path of a serialized VS Code URI (`{ fsPath, path, external }`) or a URI string. */
export function uriLikeToPath(u: unknown): string {
  if (typeof u === 'string') return fileUriToPath(u);
  if (typeof u !== 'object' || u === null) return '';
  const o = u as Record<string, unknown>;
  if (typeof o.fsPath === 'string') return o.fsPath;
  if (typeof o.external === 'string') return fileUriToPath(o.external);
  if (typeof o.path === 'string') return o.path;
  return '';
}

/** Minimal glob → RegExp: `**` any depth, `*` within a segment, `?` one char. Case-insensitive. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  const g = glob.replaceAll('\\', '/');
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`, 'i');
}

/** R3.3 – a pattern without `/` matches the folder basename, otherwise the whole path (forward slashes). */
export function matchesAnyGlob(folderPath: string, globs: readonly string[]): boolean {
  const p = folderPath.replaceAll('\\', '/').replace(/\/+$/, '');
  const base = p.split('/').pop() ?? p;
  return globs.some((g) => {
    if (typeof g !== 'string' || !g.trim()) return false;
    const re = globToRegExp(g.trim().replace(/\/+$/, ''));
    return g.includes('/') ? re.test(p) || re.test(`${p}/`) : re.test(base) || re.test(p);
  });
}
