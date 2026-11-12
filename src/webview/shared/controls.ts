import htm from 'htm';
import { h, type VNode } from 'preact';
import { useState } from 'preact/hooks';

/** Controls shared by the Search Panel and the Statistics view. */

const html = htm.bind(h);

export interface MultiSelectProps {
  label: string;
  options: readonly string[];
  selected: readonly string[];
  display?: (v: string) => string;
  onChange: (values: string[]) => void;
}

export function MultiSelect(props: MultiSelectProps): VNode {
  const [filter, setFilter] = useState('');
  const display = props.display ?? ((v: string): string => v);
  const options = [...new Set([...props.selected, ...props.options])];
  const shown = filter ? options.filter((o) => display(o).toLowerCase().includes(filter.toLowerCase())) : options;
  const toggle = (v: string, on: boolean): void => props.onChange(on ? [...props.selected, v] : props.selected.filter((x) => x !== v));
  const n = props.selected.length;
  return html`
    <details class="dropdown">
      <summary class=${n ? 'active' : ''}>${props.label}${n ? ` (${n})` : ''}</summary>
      <div class="menu">
        ${options.length > 10 ? html`<input class="menu-filter" placeholder="Filter…" aria-label=${`Filter ${props.label}`} value=${filter} onInput=${(e: Event) => setFilter((e.target as HTMLInputElement).value)} />` : ''}
        ${shown.length === 0 ? html`<div class="meta">No values</div>` : ''}
        ${shown.map(
          (o) => html`<label class="option"><input type="checkbox" checked=${props.selected.includes(o)} onChange=${(e: Event) => toggle(o, (e.target as HTMLInputElement).checked)} /> ${display(o)}</label>`,
        )}
        ${n ? html`<button class="link" onClick=${() => props.onChange([])}>Clear</button>` : ''}
      </div>
    </details>
  ` as VNode;
}

/** Dropdowns are <details>: close them on an outside click or Escape. Returns the cleanup for useEffect. */
export function closeDropdownsOnOutsideClick(): () => void {
  const close = (keep?: EventTarget | null): void => {
    for (const d of document.querySelectorAll('details.dropdown[open]')) if (!(keep instanceof Node && d.contains(keep))) d.removeAttribute('open');
  };
  const onClick = (e: MouseEvent): void => close(e.target);
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('click', onClick);
  document.addEventListener('keydown', onKey);
  return () => {
    document.removeEventListener('click', onClick);
    document.removeEventListener('keydown', onKey);
  };
}
