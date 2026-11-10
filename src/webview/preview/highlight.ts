/** Diacritics- and case-insensitive term highlighting over DOM text nodes (R7.23). No innerHTML. */

export interface Folded {
  text: string;
  /** Original string index for each folded character, plus one past the end. */
  map: number[];
}

export function fold(s: string): Folded {
  let text = '';
  const map: number[] = [];
  let i = 0;
  for (const ch of s) {
    const f = ch.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
    for (let k = 0; k < f.length; k++) map.push(i);
    text += f;
    i += ch.length;
  }
  map.push(i);
  return { text, map };
}

/** Ranges `[start, end)` in `s` where any folded term occurs (non-overlapping, left to right). */
export function findRanges(s: string, terms: readonly string[]): [number, number][] {
  const needles = terms.map((t) => fold(t).text).filter((t) => t.length > 0);
  if (!needles.length) return [];
  const { text, map } = fold(s);
  const ranges: [number, number][] = [];
  let pos = 0;
  while (pos < text.length) {
    let best: [number, number] | undefined;
    for (const n of needles) {
      const at = text.indexOf(n, pos);
      if (at >= 0 && (!best || at < best[0] || (at === best[0] && at + n.length > best[1]))) best = [at, at + n.length];
    }
    if (!best) break;
    ranges.push([map[best[0]]!, map[best[1]]!]);
    pos = best[1];
  }
  return ranges;
}

const SKIP = new Set(['SCRIPT', 'STYLE', 'MARK', 'BUTTON']);

/** Wraps matches in `<mark class="hit">`; returns the marks in document order. */
export function highlight(root: HTMLElement, terms: readonly string[]): HTMLElement[] {
  for (const old of Array.from(root.querySelectorAll('mark.hit'))) {
    const parent = old.parentNode;
    if (!parent) continue;
    parent.replaceChild(document.createTextNode(old.textContent ?? ''), old);
    parent.normalize();
  }
  if (!terms.length) return [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      for (let p = n.parentElement; p && p !== root; p = p.parentElement) if (SKIP.has(p.tagName)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
  const marks: HTMLElement[] = [];
  for (const node of nodes) {
    const ranges = findRanges(node.data, terms);
    if (!ranges.length) continue;
    let current = node;
    let offset = 0;
    for (const [start, end] of ranges) {
      const match = current.splitText(start - offset);
      const rest = match.splitText(end - start);
      const mark = document.createElement('mark');
      mark.className = 'hit';
      match.parentNode!.replaceChild(mark, match);
      mark.appendChild(match);
      marks.push(mark);
      current = rest;
      offset = end;
    }
  }
  return marks;
}
