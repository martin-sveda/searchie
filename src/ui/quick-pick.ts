import * as vscode from 'vscode';
import type { SearchResponse, SearchResult } from '../query/engine';
import { snippetToPlain } from '../query/snippet';
import type { Scope } from '../query/fts';
import { uiSettings } from '../service/config';
import { RpcCancelledError } from '../service/worker-client';
import type { SearchieService } from '../service/searchie-service';
import type { SessionActions } from '../service/session-actions';
import { relativeTime, shortModel, UNTITLED } from './format';

/** Quick Pick search (R7.8–R7.10, R7.12) with 150 ms debounce and cancellation of stale queries (R6.12). */

export const LAST_QUERY_KEY = 'searchie.lastQuery';
const DEBOUNCE_MS = 150;

export interface QuickPickScope extends Scope {
  label: string;
}

interface ResultItem extends vscode.QuickPickItem {
  result: SearchResult;
}
interface LoadMoreItem extends vscode.QuickPickItem {
  loadMore: true;
}
interface SuggestionItem extends vscode.QuickPickItem {
  suggestion: string;
}
type Item = ResultItem | LoadMoreItem | SuggestionItem;

/** R6.6 – "Did you mean" is the first item; accepting it searches for the suggestion. */
export function suggestionItem(suggestion: string): SuggestionItem {
  return { label: `$(lightbulb) Did you mean: ${suggestion}`, alwaysShow: true, suggestion };
}

const PREVIEW_BUTTON: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('open-preview'), tooltip: 'Preview' };
const NEW_WINDOW_BUTTON: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('empty-window'), tooltip: 'Open Workspace in New Window' };
const COPY_RESUME_BUTTON: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('terminal'), tooltip: 'Copy Resume Command' };
const CLEAR_SCOPE_BUTTON: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('close'), tooltip: 'Search all sessions' };

export function resultItem(r: SearchResult, now = Date.now()): ResultItem {
  const s = r.session;
  const hit = r.hits[0];
  return {
    label: `$(${s.source === 'copilot-cli' ? 'terminal' : 'comment-discussion'}) ${s.title || UNTITLED}`,
    description: [s.workspaceName, relativeTime(s.lastActivityAt, now), shortModel(s.primaryModel)].filter(Boolean).join(' · '),
    detail: hit?.snippet ? `#${hit.turnIndex + 1} ${snippetToPlain(hit.snippet)}` : undefined,
    alwaysShow: true,
    buttons: s.source === 'copilot-cli' ? [PREVIEW_BUTTON, COPY_RESUME_BUTTON] : [PREVIEW_BUTTON, NEW_WINDOW_BUTTON],
    result: r,
  };
}

/** R7.12 – selected text in the active editor (single line, ≤ 200 chars), else the last query. */
export function initialQuery(state: vscode.Memento): string {
  const editor = vscode.window.activeTextEditor;
  if (editor && !editor.selection.isEmpty) {
    const text = editor.document.getText(editor.selection).trim();
    if (text && !text.includes('\n') && text.length <= 200) return text;
  }
  return state.get<string>(LAST_QUERY_KEY) ?? '';
}

export async function showSearchQuickPick(
  service: SearchieService,
  actions: SessionActions,
  state: vscode.Memento,
  options: { query?: string; scope?: QuickPickScope } = {},
): Promise<void> {
  const qp = vscode.window.createQuickPick<Item>();
  qp.matchOnDescription = false;
  qp.matchOnDetail = false;
  qp.keepScrollPosition = true;
  qp.placeholder = 'Search Copilot chat sessions – "phrase", -exclude, prefix*, ws:, model:, mode:, tool:, file:, in:, after:, before:';
  let scope = options.scope;
  const setTitle = (warn?: string): void => {
    qp.title = `Searchie${scope ? ` – ${scope.label}` : ''}${warn ? ` – ${warn}` : ''}`;
    qp.buttons = scope ? [CLEAR_SCOPE_BUTTON] : [];
  };
  setTitle();
  qp.value = options.query ?? initialQuery(state);

  let cts: vscode.CancellationTokenSource | undefined;
  let timer: NodeJS.Timeout | undefined;
  let current: { query: string; response?: SearchResponse; items: ResultItem[] } = { query: '', items: [] };

  const render = (): void => {
    const r = current.response;
    const items: Item[] = r?.suggestion ? [suggestionItem(r.suggestion), ...current.items] : [...current.items];
    if (r && r.total > current.items.length) items.push({ label: `$(ellipsis) Load more (${current.items.length} of ${r.total})`, alwaysShow: true, loadMore: true });
    qp.items = items;
  };

  const run = async (query: string, offset: number): Promise<void> => {
    cts?.cancel();
    cts?.dispose();
    const source = new vscode.CancellationTokenSource();
    cts = source;
    qp.busy = true;
    try {
      const response = await service.search({ query, offset, scope: scope && { sessionKey: scope.sessionKey, workspaceId: scope.workspaceId, folder: scope.folder } }, source.token);
      if (source.token.isCancellationRequested) return;
      const now = Date.now();
      const items = response.results.map((r) => resultItem(r, now));
      current = offset === 0 ? { query, response, items } : { query, response, items: [...current.items, ...items] };
      setTitle([response.fuzzy ? 'fuzzy results' : undefined, response.warnings[0]].filter(Boolean).join(' – ') || undefined);
      render();
      if (offset > 0 && items[0]) qp.activeItems = [items[0]];
    } catch (e) {
      if (!(e instanceof RpcCancelledError)) {
        service.log.warn(`search failed (${(e as Error).name})`);
        setTitle('search failed – see log');
      }
    } finally {
      if (cts === source) qp.busy = false;
    }
  };

  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void run(qp.value, 0), DEBOUNCE_MS);
  };

  const done = new Promise<void>((resolve) => {
    qp.onDidChangeValue(schedule);
    qp.onDidTriggerButton((b) => {
      if (b === CLEAR_SCOPE_BUTTON) {
        scope = undefined;
        setTitle();
        void run(qp.value, 0);
      }
    });
    qp.onDidTriggerItemButton((e) => {
      if (!('result' in e.item)) return;
      const s = e.item.result.session;
      void state.update(LAST_QUERY_KEY, qp.value);
      if (e.button === PREVIEW_BUTTON) void actions.preview(s, { terms: current.response?.terms, turnIndex: e.item.result.hits[0]?.turnIndex });
      else if (e.button === COPY_RESUME_BUTTON) void actions.copyResumeCommand(s);
      else {
        qp.hide();
        void actions.openWorkspaceInNewWindow(s);
      }
    });
    qp.onDidAccept(() => {
      const item = qp.selectedItems[0] ?? qp.activeItems[0];
      if (!item) return;
      if ('loadMore' in item) {
        void run(current.query, current.items.length);
        return;
      }
      if ('suggestion' in item) {
        qp.value = item.suggestion;
        void run(item.suggestion, 0);
        return;
      }
      void state.update(LAST_QUERY_KEY, qp.value);
      qp.hide();
      void actions.open(item.result.session);
    });
    qp.onDidHide(() => {
      if (timer) clearTimeout(timer);
      cts?.cancel();
      cts?.dispose();
      void state.update(LAST_QUERY_KEY, qp.value);
      qp.dispose();
      resolve();
    });
  });
  qp.show();
  void run(qp.value, 0);
  await done;
}

/** Scope of the current window's folder group (R7.4, R7.27), or of its workspace when it has no folder. */
export function currentScope(service: SearchieService): QuickPickScope {
  const folder = service.window.folder;
  return folder !== undefined ? { label: 'current workspace', folder } : { label: 'current workspace', workspaceId: service.window.workspaceId };
}

/** R7.5 / searchInWorkspace – scope for the current window, honouring `search.defaultScope`. */
export function defaultScope(service: SearchieService): QuickPickScope | undefined {
  return uiSettings().defaultScope === 'currentWorkspace' ? currentScope(service) : undefined;
}
