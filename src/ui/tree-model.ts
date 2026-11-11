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

const SOURCE_ORDER: readonly SourceId[] = ['vscode', 'vscode-insiders', 'copilot-cli'];

/** R7.27 – group label: name followed by the sources, e.g. `searchie (VS Code, Copilot CLI)`. */
export function workspaceLabel(name: string, sources: Iterable<SourceId>): string {
  const set = new Set(sources);
  return `${name} (${SOURCE_ORDER.filter((s) => set.has(s)).map((s) => SOURCE_LABELS[s]).join(', ')})`;
}

export interface WorkspaceGroup {
  /** `folder:<key>` for folder groups, else the single workspace id. */
  id: string;
  label: string;
  /** Folder key (R5.21); undefined for a workspace without a folder (empty window, CLI without folder). */
  folder?: string;
  sources: SourceId[];
  workspaceIds: string[];
  current: boolean;
  lastActivityAt: number;
  sessions: SessionListItem[];
}

export interface CurrentWorkspace {
  ids: ReadonlySet<string>;
  /** Folder key of the current window, so a group with only CLI sessions of this folder is current too. */
  folder?: string;
}

const groupKey = (s: SessionListItem): string => (s.folder !== undefined ? `folder:${s.folder}` : s.workspaceId);

/** R7.27 / R7.4 – folder groups across sources; the current group is pinned first, the rest by last activity. */
export function groupByWorkspace(sessions: readonly SessionListItem[], current: CurrentWorkspace, sort: SortBy): WorkspaceGroup[] {
  const map = new Map<string, WorkspaceGroup & { vscodeName?: string; cliName?: string }>();
  for (const s of sessions) {
    const id = groupKey(s);
    let g = map.get(id);
    if (!g) {
      g = { id, label: '', folder: s.folder, sources: [], workspaceIds: [], current: false, lastActivityAt: 0, sessions: [] };
      map.set(id, g);
    }
    if (!g.sources.includes(s.source)) g.sources.push(s.source);
    if (!g.workspaceIds.includes(s.workspaceId)) g.workspaceIds.push(s.workspaceId);
    if (s.source === 'copilot-cli') g.cliName ??= s.workspaceName;
    else g.vscodeName ??= s.workspaceName;
    g.current ||= current.ids.has(s.workspaceId) || (s.folder !== undefined && s.folder === current.folder);
    g.sessions.push(s);
    g.lastActivityAt = Math.max(g.lastActivityAt, s.lastActivityAt);
  }
  const cmp = compareSessions(sort);
  const groups = [...map.values()].map(({ vscodeName, cliName, ...g }) => {
    g.sessions.sort(cmp);
    g.sources.sort((a, b) => SOURCE_ORDER.indexOf(a) - SOURCE_ORDER.indexOf(b));
    return { ...g, label: workspaceLabel(vscodeName ?? cliName ?? g.id, g.sources) };
  });
  return groups.sort((a, b) => Number(b.current) - Number(a.current) || b.lastActivityAt - a.lastActivityAt || a.label.localeCompare(b.label));
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
