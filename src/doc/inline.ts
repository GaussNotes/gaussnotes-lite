// Inline markdown for a paragraph: bold, italic, strikethrough, links and Pandoc
// footnotes. The paragraph's text stays exactly what was typed (so files
// round-trip); this only builds a decorated DOM for it. Marker characters are
// wrapped in .md-mark spans, which CSS hides outside the paragraph being edited.
//
// The source string uses ISLAND (a private-use char) where an equation sits.

export const ISLAND = '';

export type Tok =
  | { t: 'text'; s: string }
  | { t: 'island' }
  | { t: 'mark'; s: string }
  | { t: 'wrap'; tag: 'strong' | 'em' | 's'; open: string; close: string; kids: Tok[] }
  | { t: 'link'; href: string; open: string; close: string; kids: Tok[] }
  | { t: 'fnref'; label: string; s: string }
  | { t: 'fninline'; open: string; close: string; kids: Tok[] };

export interface BlockInfo {
  toks: Tok[];
  /** Footnote definition paragraph ("[^1]: …"). */
  fnDef?: string;
  heading?: number;
  /** Pandoc {-} / {.unnumbered}: excluded from section numbering. */
  unnumbered?: boolean;
  quote?: boolean;
}

const EMPH: [string, 'strong' | 'em' | 's', boolean][] = [
  ['***', 'strong', false], // bold+italic: rendered as strong>em below
  ['**', 'strong', false],
  ['__', 'strong', true],
  ['~~', 's', false],
  ['*', 'em', false],
  ['_', 'em', true],
];
const space = (c: string | undefined) => c === undefined || /\s/.test(c);
const word = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

/** Index of the ']' matching the '[' at `i`, or -1. */
function matchBracket(s: string, i: number, end: number): number {
  let depth = 0;
  for (let j = i; j < end; j++) {
    if (s[j] === '\\') j++;
    else if (s[j] === '[') depth++;
    else if (s[j] === ']' && --depth === 0) return j;
  }
  return -1;
}

function findClose(s: string, d: string, from: number, end: number, underscore: boolean): number {
  for (let j = from; j + d.length <= end; j++) {
    if (s[j] === '\\') {
      j++;
      continue;
    }
    if (!s.startsWith(d, j) || space(s[j - 1])) continue;
    // a lone * shouldn't close on part of a ** run
    if (d.length === 1 && (s[j + 1] === d || s[j - 1] === d)) continue;
    if (underscore && word(s[j + d.length])) continue;
    return j;
  }
  return -1;
}

export function parseInlineMd(s: string, i = 0, end = s.length): Tok[] {
  const out: Tok[] = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push({ t: 'text', s: buf });
    buf = '';
  };
  while (i < end) {
    const c = s[i];
    if (c === ISLAND) {
      flush();
      out.push({ t: 'island' });
      i++;
      continue;
    }
    if (c === '\\' && i + 1 < end && /[\\`*_{}[\]()#+\-.!~^|]/.test(s[i + 1])) {
      buf += c + s[i + 1];
      i += 2;
      continue;
    }
    // [^label] footnote reference
    if (c === '[' && s[i + 1] === '^') {
      const m = /^\[\^([^\]\s]+)\]/.exec(s.slice(i, end));
      if (m) {
        flush();
        out.push({ t: 'fnref', label: m[1], s: m[0] });
        i += m[0].length;
        continue;
      }
    }
    // ^[inline footnote]
    if (c === '^' && s[i + 1] === '[') {
      const j = matchBracket(s, i + 1, end);
      if (j > i + 2) {
        flush();
        out.push({ t: 'fninline', open: '^[', close: ']', kids: parseInlineMd(s, i + 2, j) });
        i = j + 1;
        continue;
      }
    }
    // [text](url)
    if (c === '[') {
      const j = matchBracket(s, i, end);
      if (j > i + 1 && s[j + 1] === '(') {
        const k = s.indexOf(')', j + 2);
        if (k > 0 && k < end && !/\s/.test(s.slice(j + 2, k))) {
          flush();
          out.push({ t: 'link', href: s.slice(j + 2, k), open: '[', close: s.slice(j, k + 1), kids: parseInlineMd(s, i + 1, j) });
          i = k + 1;
          continue;
        }
      }
    }
    let matched = false;
    for (const [d, tag, underscore] of EMPH) {
      if (!s.startsWith(d, i) || space(s[i + d.length]) || (underscore && word(s[i - 1]))) continue;
      if (d.length === 1 && s[i + 1] === d) continue;
      const j = findClose(s, d, i + d.length + 1, end, underscore);
      if (j < 0) continue;
      flush();
      let kids = parseInlineMd(s, i + d.length, j);
      if (d === '***') kids = [{ t: 'wrap', tag: 'em', open: '', close: '', kids }];
      out.push({ t: 'wrap', tag, open: d, close: d, kids });
      i = j + d.length;
      matched = true;
      break;
    }
    if (matched) continue;
    buf += c;
    i++;
  }
  flush();
  return out;
}

export function parseBlock(src: string): BlockInfo {
  const def = /^\[\^([^\]\s]+)\]:[ \t]?/.exec(src);
  if (def) return { fnDef: def[1], toks: [{ t: 'mark', s: def[0] }, ...parseInlineMd(src, def[0].length)] };
  const h = /^(#{1,6}) /.exec(src);
  if (h) {
    const attr = /\s*\{(?:-|\.unnumbered)\}\s*$/.exec(src);
    const end = attr ? attr.index : src.length;
    const toks: Tok[] = [{ t: 'mark', s: h[0] }, ...parseInlineMd(src, h[0].length, end)];
    if (attr) toks.push({ t: 'mark', s: attr[0] });
    return { heading: h[1].length, unnumbered: !!attr, toks };
  }
  const q = /^> /.exec(src);
  if (q) return { quote: true, toks: [{ t: 'mark', s: q[0] }, ...parseInlineMd(src, 2)] };
  return { toks: parseInlineMd(src) };
}

/** Build DOM for tokens; `islands` are the paragraph's equation elements in order (reused, not recreated). */
export function renderToks(toks: Tok[], islands: HTMLElement[]): DocumentFragment {
  const frag = document.createDocumentFragment();
  const mark = (s: string) => {
    const m = document.createElement('span');
    m.className = 'md-mark';
    m.textContent = s;
    return m;
  };
  for (const t of toks) {
    switch (t.t) {
      case 'text':
        frag.append(t.s);
        break;
      case 'island':
        if (islands.length) frag.append(islands.shift()!);
        break;
      case 'mark':
        frag.append(mark(t.s));
        break;
      case 'wrap': {
        const el = document.createElement(t.tag);
        el.append(renderToks(t.kids, islands));
        if (t.open) frag.append(mark(t.open));
        frag.append(el);
        if (t.close) frag.append(mark(t.close));
        break;
      }
      case 'link': {
        const el = document.createElement('span');
        el.className = 'md-link';
        el.dataset.href = t.href;
        el.title = `${t.href} (⌘-click to open)`;
        const text = document.createElement('span');
        text.className = 'md-linktext';
        text.append(renderToks(t.kids, islands));
        el.append(mark(t.open), text, mark(t.close));
        frag.append(el);
        break;
      }
      case 'fnref': {
        const el = document.createElement('sup');
        el.className = 'md-fnref';
        el.dataset.label = t.label;
        el.append(mark(t.s));
        frag.append(el);
        break;
      }
      case 'fninline': {
        const el = document.createElement('span');
        el.className = 'md-fninline';
        const body = document.createElement('span');
        body.className = 'md-fnbody';
        body.append(renderToks(t.kids, islands));
        el.append(mark(t.open), body, mark(t.close));
        frag.append(el);
        break;
      }
    }
  }
  return frag;
}
