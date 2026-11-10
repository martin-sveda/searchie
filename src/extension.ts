import * as vscode from 'vscode';
import { SearchieService } from './service/searchie-service';
import type { SessionActions } from './service/session-actions';
import { registerCommands } from './ui/commands';
import { PreviewManager } from './ui/preview-panel';
import { SessionOpener } from './service/session-opener';
import { StatusBar } from './ui/status-bar';
import { SessionsTreeProvider, type TreeNode } from './ui/tree';

/** Test/diagnostic surface returned from activate (used by the smoke tests only). */
export interface SearchieApi {
  activationMs: number;
  service: SearchieService;
  tree: SessionsTreeProvider;
  /** Smoke tests replace the session actions to observe Quick Pick / tree results. */
  setActions(actions: SessionActions | undefined): void;
}

export function activate(context: vscode.ExtensionContext): SearchieApi {
  const t0 = performance.now();
  const log = vscode.window.createOutputChannel('Searchie', { log: true });
  const service = new SearchieService(context, log);
  const tree = new SessionsTreeProvider(service, context.globalState);
  const view = vscode.window.createTreeView<TreeNode>('searchie.sessions', { treeDataProvider: tree, showCollapseAll: true });
  tree.view = view;
  const opener = new SessionOpener(service);
  const previews = new PreviewManager(context, service, opener);
  opener.attachPreviews(previews);
  const defaultActions: SessionActions = opener;
  let impl = defaultActions;
  const actions: SessionActions = {
    open: (s) => impl.open(s),
    preview: (s, o) => impl.preview(s, o),
    openWorkspaceInNewWindow: (s) => impl.openWorkspaceInNewWindow(s),
  };
  context.subscriptions.push(log, service, tree, view, previews, opener, new StatusBar(service), ...registerCommands({ context, service, tree, view, actions }));
  // The worker and the first sync start after activation (N1, R5.13).
  setTimeout(() => {
    service
      .start()
      .then(() => opener.startPendingOpenListener())
      .catch((e: unknown) => log.error(`start failed (${(e as Error).name})`));
  }, 0);
  const activationMs = performance.now() - t0;
  log.info(`activated in ${activationMs.toFixed(1)} ms (VS Code ${vscode.version})`);
  return {
    activationMs,
    service,
    tree,
    setActions: (a) => {
      impl = a ?? defaultActions;
    },
  };
}

export function deactivate(): void {
  // Disposables registered in context.subscriptions release the lock and stop the worker.
}
