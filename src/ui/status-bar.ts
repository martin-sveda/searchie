import * as vscode from 'vscode';
import type { IndexStatus, SearchieService } from '../service/searchie-service';
import { formatCount, plural } from './format';

/** Status bar item (R7.26): click = search; progress while indexing; warning on errors. */
export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('searchie.status', vscode.StatusBarAlignment.Right, 100);
  private readonly sub: vscode.Disposable;

  constructor(service: SearchieService) {
    this.item.name = 'Searchie';
    this.item.command = 'searchie.search';
    this.update(service.currentStatus);
    this.sub = service.onDidChangeStatus((s) => this.update(s));
    this.item.show();
  }

  update(s: IndexStatus): void {
    if (s.state === 'indexing') {
      this.item.text = s.total ? `$(sync~spin) Searchie: indexing ${formatCount(s.done)}/${formatCount(s.total)}` : '$(sync~spin) Searchie: indexing';
      this.item.tooltip = 'Searchie is updating its index. Search works with the current data.';
    } else if (s.state === 'error' || s.failedFiles > 0) {
      this.item.text = '$(warning) Searchie';
      this.item.tooltip = s.state === 'error' ? 'Searchie: indexing error – see Searchie: Show Log' : `Searchie: ${plural(s.failedFiles, 'session file')} could not be indexed – see Searchie: Show Log`;
    } else if (s.state === 'deleted') {
      this.item.text = '$(search) Searchie';
      this.item.tooltip = 'Searchie: index deleted – run Searchie: Refresh Index to rebuild';
    } else {
      this.item.text = '$(search) Searchie';
      this.item.tooltip = s.sessions ? `Search ${plural(s.sessions, 'Copilot chat session')}` : 'Search Copilot chat sessions';
    }
  }

  dispose(): void {
    this.sub.dispose();
    this.item.dispose();
  }
}
