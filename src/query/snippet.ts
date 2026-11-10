import { redactSecrets } from '../core/vendor/redact-secrets';

/** Snippet helpers (§6.4). Snippets carry control-char markers; UIs escape first, then mark (R6.10). */

export const MARK_START = '\u0001';
export const MARK_END = '\u0002';

/** R6.11 – redacts secrets and collapses whitespace; markers are preserved. */
export function cleanSnippet(raw: string, redact: boolean): string {
  const text = raw.replaceAll(/\s+/g, ' ').trim();
  return redact ? redactSecrets(text) : text;
}

export function escapeHtml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

/** R6.10 – HTML-escape the whole snippet first, then turn markers into `<mark>`. Unbalanced markers are dropped. */
export function snippetToHtml(snippet: string): string {
  let out = '';
  let open = false;
  for (const ch of escapeHtml(snippet)) {
    if (ch === MARK_START) {
      if (!open) out += '<mark>';
      open = true;
    } else if (ch === MARK_END) {
      if (open) out += '</mark>';
      open = false;
    } else {
      out += ch;
    }
  }
  return open ? `${out}</mark>` : out;
}

/** Quick Pick can't highlight: matched terms are shown in «» (R7.8). */
export function snippetToPlain(snippet: string): string {
  return snippet.replaceAll(MARK_START, '«').replaceAll(MARK_END, '»');
}

export const hasMark = (snippet: string): boolean => snippet.includes(MARK_START);
