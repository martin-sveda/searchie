import { createHash } from 'node:crypto';
import { fileUriToPath } from './text';

/** Folder keys (SPEC R5.21): one normalized identity per project folder, shared by all sources. */

const SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i;

function isWindowsLike(p: string): boolean {
  return /^[a-zA-Z]:(\/|$)/.test(p) || p.startsWith('//');
}

/** Normalized folder key for a folder path or URI, or undefined when there is none. */
export function folderKey(raw: string | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined;
  let s = raw.trim();
  if (!s) return undefined;
  const scheme = SCHEME.exec(s)?.[1]?.toLowerCase();
  if (scheme && scheme !== 'file') {
    try {
      const u = new URL(s);
      let p = u.pathname;
      try {
        p = decodeURIComponent(p);
      } catch {
        // keep encoded path
      }
      return `${scheme}://${u.host.toLowerCase()}${p.replace(/\/+$/, '')}`;
    } catch {
      return s;
    }
  }
  if (scheme === 'file') s = fileUriToPath(s);
  s = s.replaceAll('\\', '/');
  const windows = isWindowsLike(s);
  s = s.length > 1 ? s.replace(/\/+$/, '') : s;
  if (/^[a-zA-Z]:$/.test(s)) s += '/';
  return windows ? s.toLowerCase() : s;
}

/** Short stable hash of a folder key, used in CLI workspace ids so ids and logs never contain paths. */
export function folderHash(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16);
}

/** `file://` URI for a local folder path (POSIX or Windows style). */
export function folderPathToUri(p: string): string {
  const slashed = p.replaceAll('\\', '/');
  const withRoot = slashed.startsWith('/') ? slashed : `/${slashed}`;
  return `file://${encodeURI(withRoot).replaceAll('?', '%3F').replaceAll('#', '%23')}`;
}
