/** Pure formatting helpers for tree, Quick Pick and tooltips (no vscode dependency). */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function relativeTime(ts: number, now = Date.now()): string {
  const d = now - ts;
  if (d < MINUTE) return 'just now';
  if (d < HOUR) return `${Math.floor(d / MINUTE)}m ago`;
  if (d < DAY) return `${Math.floor(d / HOUR)}h ago`;
  if (d < 7 * DAY) return `${Math.floor(d / DAY)}d ago`;
  const date = new Date(ts);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString('en-US', sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatDateTime(ts: number): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 6210 → "6 210"; 3100 → "3.1k" when `compact`. Missing data is "—", never 0 (§9.1). */
export function formatCount(n: number | null | undefined, compact = false): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (compact && Math.abs(n) >= 1000) {
    const k = n / 1000;
    return `${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, '')}k`;
  }
  const rounded = Math.abs(n) < 100 && !Number.isInteger(n) ? n.toFixed(1) : String(Math.round(n));
  return rounded.replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0');
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** `copilot/claude-sonnet-5.5` → `claude-sonnet-5.5`. */
export function shortModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  return model.replace(/^copilot\//i, '');
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

export const UNTITLED = 'Untitled session';

/** Escapes text for a MarkdownString (tooltips): no links, HTML or emphasis from session data. */
export function escapeMarkdown(text: string): string {
  return text.replaceAll(/[\\`*_{}[\]()#+\-.!|<>~]/g, (c) => `\\${c}`);
}
