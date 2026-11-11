import htm from 'htm';
import { h, render, type VNode } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { HostToWebviewSchema, type PreviewData, type PreviewTurn, type WebviewToHost } from '../protocol';
import { highlight } from './highlight';
import { renderMarkdown } from './markdown';

/** Preview webview (R7.21–R7.25). All data arrives via validated messages; text is rendered escaped by Preact. */

declare function acquireVsCodeApi(): { postMessage(m: WebviewToHost): void; getState(): unknown; setState(s: unknown): void };

const vscode = acquireVsCodeApi();
const html = htm.bind(h);

interface InitState {
  data: PreviewData;
  terms: string[];
  scrollTo?: number;
  redacted: boolean;
  canOpenInChat: boolean;
  canOpenNewWindow: boolean;
  openInChatLabel: string;
  newWindowLabel: string;
  canCopyResume: boolean;
}

interface SavedState {
  scrollY?: number;
}

const fmtDate = (ts: number): string => (ts ? new Date(ts).toLocaleString() : '—');
const fmtNum = (n: number | undefined): string => (n === undefined ? '—' : n.toLocaleString());

function Markdown({ text }: { text: string }): VNode {
  // markdown-it runs with html: false and a link allow-list, so its output contains no raw HTML from the session.
  return html`<div class="markdown" dangerouslySetInnerHTML=${{ __html: renderMarkdown(text) }}></div>` as VNode;
}

function Turn({ turn, files }: { turn: PreviewTurn; files: PreviewData['files'] }): VNode {
  return html`
    <section class="turn" id=${`turn-${turn.index}`}>
      <div class="role user">You${turn.noise ? html` <span class="badge">trivial</span>` : ''}</div>
      <div class="prompt">${turn.prompt}</div>
      <div class="role assistant">
        Copilot${turn.model ? html` <span class="meta">${turn.model}${turn.mode ? ` · ${turn.mode}` : ''}</span>` : ''}${turn.canceled ? html` <span class="badge">canceled</span>` : ''}
      </div>
      ${turn.parts.map((p) =>
        p.kind === 'markdown'
          ? html`<${Markdown} text=${p.text} />`
          : p.kind === 'thinking'
            ? html`<details class="thinking"><summary>Thinking</summary><div class="thinking-text">${p.text}</div></details>`
            : html`<div class="tool" title=${p.args}><span class="tool-name">${p.tool}</span>${p.args ? html` <span class="tool-args">${p.args}</span>` : ''}</div>`,
      )}
      ${turn.files.length
        ? html`<div class="files">
            ${turn.files.map((i) => {
              const f = files[i];
              if (!f) return '';
              return f.exists
                ? html`<a href="#" class="file" title=${f.path} data-file=${i}>${f.label}</a>`
                : html`<span class="file missing" title=${`${f.path} (not on this machine)`}>${f.label}</span>`;
            })}
          </div>`
        : ''}
    </section>
  ` as VNode;
}

function App(): VNode {
  const [state, setState] = useState<InitState | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [matchCount, setMatchCount] = useState(0);
  const [current, setCurrent] = useState(-1);
  // Highlighting splits text nodes Preact rendered; a new key remounts <main> for every init instead of patching them.
  const [version, setVersion] = useState(0);
  const body = useRef<HTMLDivElement>(null);
  const marks = useRef<HTMLElement[]>([]);
  const reveal = useRef<{ terms: string[]; scrollTo?: number } | undefined>();

  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      const parsed = HostToWebviewSchema.safeParse(e.data);
      if (!parsed.success) return;
      const m = parsed.data;
      if (m.type === 'init') {
        reveal.current = { terms: m.terms, scrollTo: m.scrollTo };
        setError(undefined);
        setVersion((v) => v + 1);
        setState({ data: m.data, terms: m.terms, scrollTo: m.scrollTo, redacted: m.redacted, canOpenInChat: m.canOpenInChat, canOpenNewWindow: m.canOpenNewWindow, openInChatLabel: m.openInChatLabel, newWindowLabel: m.newWindowLabel, canCopyResume: m.canCopyResume });
      } else if (m.type === 'reveal') {
        reveal.current = { terms: m.terms, scrollTo: m.scrollTo };
        setState((s) => (s ? { ...s, terms: m.terms, scrollTo: m.scrollTo } : s));
      } else setError(m.message);
    };
    window.addEventListener('message', onMessage);
    vscode.postMessage({ type: 'ready' });
    let pending = false;
    const onScroll = (): void => {
      if (pending) return;
      pending = true;
      setTimeout(() => {
        pending = false;
        vscode.setState({ scrollY: window.scrollY } satisfies SavedState);
      }, 200);
    };
    window.addEventListener('scroll', onScroll);
    const onClick = (e: MouseEvent): void => {
      const a = (e.target as HTMLElement | null)?.closest('a');
      if (!a) return;
      e.preventDefault();
      const file = a.getAttribute('data-file');
      if (file !== null) vscode.postMessage({ type: 'openFile', file: Number(file) });
      else {
        const href = a.getAttribute('href') ?? '';
        if (href.startsWith('#')) document.getElementById(href.slice(1))?.scrollIntoView();
        else if (href) vscode.postMessage({ type: 'openLink', href });
      }
    };
    document.addEventListener('click', onClick);
    return () => {
      window.removeEventListener('message', onMessage);
      window.removeEventListener('scroll', onScroll);
      document.removeEventListener('click', onClick);
    };
  }, []);

  // After each render with new data or terms: highlight terms (R7.23), then scroll to the target turn or saved position.
  useEffect(() => {
    if (!state || !body.current) return;
    marks.current = highlight(body.current, state.terms);
    setMatchCount(marks.current.length);
    setCurrent(-1);
    const r = reveal.current;
    reveal.current = undefined;
    if (r?.scrollTo !== undefined) document.getElementById(`turn-${r.scrollTo}`)?.scrollIntoView({ block: 'start' });
    else if (r) {
      const saved = vscode.getState() as SavedState | undefined;
      if (saved?.scrollY) window.scrollTo(0, saved.scrollY);
    }
  }, [state]);

  const go = (delta: number): void => {
    const list = marks.current;
    if (!list.length) return;
    const next = (current + delta + list.length) % list.length;
    list[current]?.classList.remove('current');
    list[next]!.classList.add('current');
    list[next]!.scrollIntoView({ block: 'center' });
    setCurrent(next);
  };

  if (error) return html`<div class="error">${error}</div>` as VNode;
  if (!state) return html`<div class="loading">Loading session…</div>` as VNode;
  const d = state.data;
  return html`
    <header>
      <h1>${d.title}</h1>
      <div class="meta">
        ${d.workspaceName} · ${d.sourceLabel} · ${fmtDate(d.createdAt)} – ${fmtDate(d.lastActivityAt)}
        ${d.models.length ? ` · ${d.models.join(', ')}` : ''}${d.modes.length ? ` · ${d.modes.join(', ')}` : ''}
      </div>
      <div class="meta">
        ${d.turnCount} turns${d.hiddenTurns ? ` (+${d.hiddenTurns} hidden)` : ''} · tokens ${fmtNum(d.promptTokens)} / ${fmtNum(d.completionTokens)} · credits ${fmtNum(d.credits)}
      </div>
      <div class="actions">
        ${state.canOpenInChat ? html`<button onClick=${() => vscode.postMessage({ type: 'openInChat' })}>${state.openInChatLabel}</button>` : ''}
        ${state.canOpenNewWindow ? html`<button class="secondary" onClick=${() => vscode.postMessage({ type: 'openNewWindow' })}>${state.newWindowLabel}</button>` : ''}
        ${state.canCopyResume ? html`<button class="secondary" onClick=${() => vscode.postMessage({ type: 'copyResumeCommand' })}>Copy Resume Command</button>` : ''}
        <button class="secondary" onClick=${() => vscode.postMessage({ type: 'copySessionId' })}>Copy Session ID</button>
        <label class="toggle">
          <input type="checkbox" checked=${!state.redacted} onChange=${(e: Event) => vscode.postMessage({ type: 'setRedacted', redacted: !(e.target as HTMLInputElement).checked })} />
          Show secrets
        </label>
        ${state.terms.length
          ? html`<span class="find">
              ${matchCount} ${matchCount === 1 ? 'match' : 'matches'}
              <button class="icon" title="Previous match" onClick=${() => go(-1)} disabled=${!matchCount}>↑</button>
              <button class="icon" title="Next match" onClick=${() => go(1)} disabled=${!matchCount}>↓</button>
            </span>`
          : ''}
      </div>
    </header>
    <main key=${version} ref=${body}>
      ${d.turns.length ? d.turns.map((t) => html`<${Turn} key=${t.index} turn=${t} files=${d.files} />`) : html`<div class="empty">No visible turns.</div>`}
    </main>
  ` as VNode;
}

render(h(App, null), document.getElementById('app')!);
