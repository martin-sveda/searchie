import { SOURCE_LABELS, type SourceId } from '../core/ids';
import type { SessionListItem } from '../store/index-db';

/** Pure grouping and sorting for the Sessions tree (R7.1, R7.2, R7.4). */

export type GroupBy = 'workspaceDate' | 'dateWorkspace' | 'flat';
export type SortBy = 'lastActivity' | 'created' | 'prompts' | 'credits';

export const SORT_LABELS: Record<SortBy, string> = {
  lastActivity: 'Last activity',
  created: 'Created',
  prompts: 'Prompts',
  credits: 'Credits',
};

export interface DateBucket {
  id: string;
  label: string;
  order: number;
}

const DAY = 86_400_000;

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Today, Yesterday, Last 7 days, Last 30 days, then calendar months. */
export function dateBucket(ts: number, now = Date.now()): DateBucket {
  const today = startOfDay(now);
  if (ts >= today) return { id: 'today', label: 'Today', order: 0 };
  if (ts >= today - DAY) return { id: 'yesterday', label: 'Yesterday', order: 1 };
  if (ts >= today - 7 * DAY) return { id: 'week', label: 'Last 7 days', order: 2 };
  if (ts >= today - 30 * DAY) return { id: 'month', label: 'Last 30 days', order: 3 };
  const d = new Date(ts);
  return {
    id: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
    label: d.toLocaleDateString('en-US', { year: 'numeric', month: 'long' }),
    order: 4 + (new Date(now).getFullYear() - d.getFullYear()) * 12 + (new Date(now).getMonth() - d.getMonth()),
  };
}

export function compareSessions(sort: SortBy): (a: SessionListItem, b: SessionListItem) => number {
  const key = (s: SessionListItem): number => {
    switch (sort) {
      case 'created':
        return s.createdAt;
      case 'prompts':
        return s.promptCount;
      case 'credits':
        return s.credits ?? -1;
      default:
        return s.lastActivityAt;
    }
  };
  return (a, b) => key(b) - key(a) || b.lastActivityAt - a.lastActivityAt || (a.key < b.key ? -1 : 1);
}

export function workspaceLabel(name: string, source: SourceId): string {
  return `${name} (${SOURCE_LABELS[source]})`;
}

export interface WorkspaceGroup {
  id: string;
  label: string;
  source: SourceId;
  current: boolean;
  lastActivityAt: number;
  sessions: SessionListItem[];
}

/** Groups by workspace; the current workspace (or any of its ids) is pinned first, the rest by last activity. */
export function groupByWorkspace(sessions: readonly SessionListItem[], currentIds: ReadonlySet<string>, sort: SortBy): WorkspaceGroup[] {
  const map = new Map<string, WorkspaceGroup>();
  for (const s of sessions) {
    let g = map.get(s.workspaceId);
    if (!g) {
      g = { id: s.workspaceId, label: workspaceLabel(s.workspaceName, s.source), source: s.source, current: currentIds.has(s.workspaceId), lastActivityAt: 0, sessions: [] };
      map.set(s.workspaceId, g);
    }
    g.sessions.push(s);
    g.lastActivityAt = Math.max(g.lastActivityAt, s.lastActivityAt);
  }
  const cmp = compareSessions(sort);
  for (const g of map.values()) g.sessions.sort(cmp);
  return [...map.values()].sort((a, b) => Number(b.current) - Number(a.current) || b.lastActivityAt - a.lastActivityAt || a.label.localeCompare(b.label));
}

export interface DateGroup {
  bucket: DateBucket;
  sessions: SessionListItem[];
}

export function groupByDate(sessions: readonly SessionListItem[], sort: SortBy, now = Date.now()): DateGroup[] {
  const map = new Map<string, DateGroup>();
  for (const s of sessions) {
    const bucket = dateBucket(s.lastActivityAt, now);
    const g = map.get(bucket.id) ?? { bucket, sessions: [] };
    g.sessions.push(s);
    map.set(bucket.id, g);
  }
  const cmp = compareSessions(sort);
  for (const g of map.values()) g.sessions.sort(cmp);
  return [...map.values()].sort((a, b) => a.bucket.order - b.bucket.order);
}

export interface TreeFilter {
  sources?: string[];
  models?: string[];
  modes?: string[];
  /** Days back from now (e.g. 7, 30, 90); undefined = any time. */
  days?: number;
}

export function filterSummary(f: TreeFilter): string | undefined {
  const parts: string[] = [];
  if (f.sources?.length) parts.push(f.sources.map((s) => SOURCE_LABELS[s as SourceId] ?? s).join(', '));
  if (f.models?.length) parts.push(f.models.join(', '));
  if (f.modes?.length) parts.push(f.modes.join(', '));
  if (f.days) parts.push(`last ${f.days} days`);
  return parts.length ? parts.join(' · ') : undefined;
}
