import * as vscode from 'vscode';
import type { IndexerSettings } from '../worker/indexer';
import type { GroupBy } from '../ui/tree-model';

/** Typed access to `searchie.*` settings (§12.1). */

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const num = (v: unknown, def: number, min: number, max: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def);

export function indexerSettings(): IndexerSettings {
  const c = vscode.workspace.getConfiguration('searchie');
  return {
    vscode: c.get<boolean>('sources.vscode', true),
    vscodeInsiders: c.get<boolean>('sources.vscodeInsiders', true),
    emptyWindow: c.get<boolean>('sources.emptyWindow', true),
    additionalSessionRoots: strings(c.get('additionalSessionRoots')),
    excludeWorkspaces: strings(c.get('excludeWorkspaces')),
    includeThinking: c.get<boolean>('index.includeThinking', false),
    maxTurnTextKB: num(c.get('index.maxTurnTextKB'), 64, 4, 1024),
    noisePatterns: strings(c.get('noisePatterns')),
  };
}

export interface UiSettings {
  defaultScope: 'all' | 'currentWorkspace';
  recencyBoost: number;
  maxResults: number;
  otherWorkspaceDefault: 'ask' | 'preview' | 'newWindow';
  chatLocation: 'view' | 'editor';
  groupBy: GroupBy;
  redactSecrets: boolean;
  pollIntervalMinutes: number;
  /** Hidden setting (R6.8), not contributed in package.json. */
  weights: Record<string, unknown> | undefined;
}

export function uiSettings(): UiSettings {
  const c = vscode.workspace.getConfiguration('searchie');
  const pick = <T extends string>(v: unknown, allowed: readonly T[], def: T): T => (allowed.includes(v as T) ? (v as T) : def);
  const weights = c.get<unknown>('search.weights');
  return {
    defaultScope: pick(c.get('search.defaultScope'), ['all', 'currentWorkspace'], 'all'),
    recencyBoost: num(c.get('search.recencyBoost'), 0.2, 0, 5),
    maxResults: Math.round(num(c.get('search.maxResults'), 50, 10, 500)),
    otherWorkspaceDefault: pick(c.get('open.otherWorkspaceDefault'), ['ask', 'preview', 'newWindow'], 'ask'),
    chatLocation: pick(c.get('open.chatLocation'), ['view', 'editor'], 'view'),
    groupBy: pick(c.get('tree.groupBy'), ['workspaceDate', 'dateWorkspace', 'flat'], 'workspaceDate'),
    redactSecrets: c.get<boolean>('redactSecrets', true),
    pollIntervalMinutes: num(c.get('index.pollIntervalMinutes'), 5, 0, 24 * 60),
    weights: weights && typeof weights === 'object' ? (weights as Record<string, unknown>) : undefined,
  };
}

/** Settings whose change requires the worker to re-read its configuration and re-scan. */
export const INDEX_SETTINGS = ['searchie.sources', 'searchie.additionalSessionRoots', 'searchie.excludeWorkspaces', 'searchie.index', 'searchie.noisePatterns'];
