import { AUTO, autoKeyword, growingSuffix, isKeywordPrefix, keyword, type KW, settledKeyword, symbolKeyword } from './keywords';
import { type Cmd, type Cursor, clone, cmd, isEmptyCmd, isLetter, isOperand, isScript, isTextRow, type MNode, ownerOf, type Row, rowAt, type Step, sym } from './model';

export const settings = {
  /** Convert keywords (sum, alpha, sqrt…) the moment they're typed, instead of on space/Tab. */
  instantKeywords: true,
};

// Pure operations on (root, cursor). They mutate `root` in place and return the
// new cursor, or null when the cursor would leave the equation.

const at = (path: Step[], off: number): Cursor => ({ path, off });

function enter(node: Cmd, path: Step[], idx: number, slot: number, end: boolean): Cursor {
  const p: Step[] = [...path, [idx, slot]];
  return at(p, end ? node.slots[slot].length : 0);
}

export function moveRight(root: Row, c: Cursor): Cursor | null {
  const row = rowAt(root, c.path);
  if (c.off < row.length) {
    const n = row[c.off];
    return n.k === 'cmd' ? enter(n, c.path, c.off, 0, false) : at(c.path, c.off + 1);
  }
  if (!c.path.length) return null;
  const [ni, si] = c.path[c.path.length - 1];
  const parent = c.path.slice(0, -1);
  const owner = ownerOf(root, c.path)!;
  if (si + 1 < owner.slots.length) return at([...parent, [ni, si + 1]], 0);
  // Leaving a subscript straight into the superscript beside it (\sum_{a}^{b}).
  const next = rowAt(root, parent)[ni + 1];
  if (isScript(owner) && isScript(next)) return enter(next as Cmd, parent, ni + 1, 0, false);
  return at(parent, ni + 1);
}

export function moveLeft(root: Row, c: Cursor): Cursor | null {
  const row = rowAt(root, c.path);
  if (c.off > 0) {
    const n = row[c.off - 1];
    return n.k === 'cmd' ? enter(n, c.path, c.off - 1, n.slots.length - 1, true) : at(c.path, c.off - 1);
  }
  if (!c.path.length) return null;
  const [ni, si] = c.path[c.path.length - 1];
  const parent = c.path.slice(0, -1);
  if (si > 0) return at([...parent, [ni, si - 1]], rowAt(root, [...parent, [ni, si - 1]]).length);
  const prev = rowAt(root, parent)[ni - 1];
  if (isScript(ownerOf(root, c.path)!) && isScript(prev)) return enter(prev as Cmd, parent, ni - 1, 0, true);
  return at(parent, ni);
}

/** Slot vertically adjacent to the cursor's slot (fraction num/den, matrix rows, sub/sup). */
export function verticalTarget(root: Row, c: Cursor, dir: -1 | 1): Step[] | null {
  for (let d = c.path.length; d > 0; d--) {
    const path = c.path.slice(0, d);
    const [ni, si] = path[d - 1];
    const parent = path.slice(0, -1);
    const owner = ownerOf(root, path)!;
    const prow = rowAt(root, parent);
    let target: Step | null = null;
    if (owner.name === 'matrix') {
      const t = si + dir * (owner.cols ?? 1);
      if (t >= 0 && t < owner.slots.length) target = [ni, t];
    } else if (owner.slots.length === 2 && ['frac', 'dfrac', 'tfrac', 'binom', 'overset', 'underset', 'root'].includes(owner.name)) {
      const t = si + dir;
      if (t === 0 || t === 1) target = [ni, t];
    } else if (owner.name === 'sub' || owner.name === 'sup') {
      const want = dir < 0 ? 'sup' : 'sub';
      if (owner.name !== want) {
        for (const j of [ni - 1, ni + 1]) {
          const n = prow[j];
          if (n?.k === 'cmd' && n.name === want) target = [j, 0];
        }
      }
    }
    if (target) return [...parent, target];
  }
  return null;
}

/** Trailing run of single-letter atoms before the cursor. */
function letterRun(root: Row, c: Cursor): number {
  const row = rowAt(root, c.path);
  let i = c.off;
  while (i > 0 && isLetter(row[i - 1])) i--;
  return c.off - i;
}

/** Trailing run of single-character symbols (letters and punctuation, not digits) before the cursor. */
function charRun(root: Row, c: Cursor): number {
  const row = rowAt(root, c.path);
  let i = c.off;
  while (i > 0) {
    const n = row[i - 1];
    if (n.k !== 'sym' || n.tex.length !== 1 || /[0-9\\]/.test(n.tex)) break;
    i--;
  }
  return c.off - i;
}

const text = (row: Row, from: number, to: number) => row.slice(from, to).map((x) => (x as { tex: string }).tex).join('');

/** Replace row[from..cursor) with a keyword's nodes and put the cursor where the keyword says. */
function place(root: Row, c: Cursor, kw: KW | MNode, from: number): Cursor {
  const { nodes, at: where } = 'nodes' in kw ? kw : { nodes: [kw], at: undefined };
  const row = rowAt(root, c.path);
  row.splice(from, c.off - from, ...nodes);
  if (where === 'after') return at(c.path, from + nodes.length);
  if (where) return at([...c.path, [from + where[0], where[1]]], where[2]);
  const i = nodes.findIndex((n) => n.k === 'cmd');
  if (i >= 0) return enter(nodes[i] as Cmd, c.path, from + i, 0, false);
  return at(c.path, from + nodes.length);
}

function instantSymbols(root: Row, c: Cursor): Cursor | null {
  const row = rowAt(root, c.path);
  const n = charRun(root, c);
  for (let len = Math.min(n, 8); len >= 2; len--) {
    const kw = symbolKeyword(text(row, c.off - len, c.off));
    if (kw) return place(root, c, kw, c.off - len);
  }
  return null;
}

function instantWord(root: Row, c: Cursor): Cursor | null {
  const row = rowAt(root, c.path);
  const n = letterRun(root, c);
  const before = row[c.off - n - 1];
  if (before?.k === 'sym' && before.tex === '\\') return null; // explicit \command: wait for space
  const word = text(row, c.off - n, c.off);
  // Don't fire a short keyword inside a longer word still being typed (rt inside vartheta).
  const min = Math.max(2, growingSuffix(word));
  for (let len = n; len >= min; len--) {
    const kw = autoKeyword(word.slice(n - len));
    if (kw) return place(root, c, kw, c.off - len);
  }
  return null;
}

/** A waiting keyword at the end of `word` that `next` rules out (sin + x), unless a longer word is still growing. */
function settledSuffix(word: string, next: string): number {
  const growing = growingSuffix(word + next) - 1; // part of `word` that continues with `next`
  for (let len = word.length; len >= 2 && len > growing; len--) if (settledKeyword(word.slice(word.length - len), next)) return len;
  return 0;
}

/** Convert the word before the cursor into a keyword. `anySuffix` allows "xalpha" → x·α. */
export function completeWord(root: Row, c: Cursor, anySuffix: boolean, tab = false): Cursor | null {
  if (isTextRow(root, c.path)) return null;
  const row = rowAt(root, c.path);
  const n = letterRun(root, c);
  const backslash = row[c.off - n - 1]?.k === 'sym' && (row[c.off - n - 1] as { tex: string }).tex === '\\';
  const word = row.slice(c.off - n, c.off).map((x) => (x as { tex: string }).tex).join('');
  if (backslash) {
    if (!n) return null;
    return place(root, c, keyword(word) ?? sym('\\' + word), c.off - n - 1);
  }
  if (anySuffix) {
    // Matrix shortcuts like pmat2x3 mix letters and digits.
    let i = c.off;
    while (i > 0 && row[i - 1].k === 'sym' && /^[a-zA-Z0-9]$/.test((row[i - 1] as { tex: string }).tex)) i--;
    const alnum = row.slice(i, c.off).map((x) => (x as { tex: string }).tex).join('');
    const m = /(?:p|b|v|B|V)?(?:mat|sys)\dx?\d?$/.exec(alnum);
    const node = m && keyword(m[0]);
    if (node) return place(root, c, node, c.off - m[0].length);
  }
  if (anySuffix) {
    // Space/Tab: the longest keyword ending at the cursor, symbols included (sub=, u++).
    const m = charRun(root, c);
    for (let len = m; len >= 1; len--) {
      const w = text(row, c.off - len, c.off);
      if (!tab && /^[|[]+$/.test(w)) continue; // bare | and [ become brackets on Tab only ("a | b" stays)
      const kw = keyword(w);
      if (kw) return place(root, c, kw, c.off - len);
    }
    return null;
  }
  const kw = n ? keyword(word) : null;
  return kw ? place(root, c, kw, c.off - n) : null;
}

function autoReplace(root: Row, c: Cursor): Cursor {
  const row = rowAt(root, c.path);
  for (const [seq, tex] of AUTO) {
    const start = c.off - seq.length;
    if (start < 0) continue;
    if (seq.every((t, j) => row[start + j].k === 'sym' && (row[start + j] as { tex: string }).tex === t))
      return place(root, c, sym(tex), start);
  }
  return c;
}

const CLOSERS: Record<string, string> = { ')': ')', ']': ']', '}': '\\}', '|': '|' };
// Typed brackets that auto-close, as in the original: '[' and '|' stay bare (intervals, "divides")
// and become brackets only on space/Tab.
const OPENERS: Record<string, [string, string]> = { '(': ['(', ')'], '{': ['\\{', '\\}'] };

/** Type one character at the cursor. */
export function typeChar(root: Row, c: Cursor, ch: string): Cursor {
  if (isTextRow(root, c.path)) {
    rowAt(root, c.path).splice(c.off, 0, sym(ch));
    return at(c.path, c.off + 1);
  }
  if (!/[a-zA-Z]/.test(ch)) {
    // A pending word converts before punctuation, unless the punctuation continues it (sub=, not=).
    const r = rowAt(root, c.path);
    const n = letterRun(root, c);
    if (!isKeywordPrefix(text(r, c.off - n, c.off) + ch)) c = completeWord(root, c, false) ?? c;
  }
  const row = rowAt(root, c.path);

  const owner = ownerOf(root, c.path);
  // Closing a bracket we're inside of jumps out of it.
  if (owner?.name === 'delim' && CLOSERS[ch] && owner.close === CLOSERS[ch]) {
    const parent = c.path.slice(0, -1);
    return at(parent, c.path[c.path.length - 1][0] + 1);
  }
  if (ch === '^' || ch === '_') {
    const name = ch === '^' ? 'sup' : 'sub';
    // At the end of a script slot (e.g. a prefilled \sum): an empty slot of the same kind is
    // used as is; the other script goes beside this one, not nested inside it.
    if (owner && isScript(owner) && c.off === row.length) {
      if (owner.name === name && !row.length) return c;
      if (owner.name !== name) {
        const [ni] = c.path[c.path.length - 1];
        const parent = c.path.slice(0, -1);
        const prow = rowAt(root, parent);
        for (const j of [ni + 1, ni - 1]) {
          const sib = prow[j];
          if (sib?.k === 'cmd' && sib.name === name) return enter(sib, parent, j, 0, true);
        }
        const s = cmd(name);
        prow.splice(ni + 1, 0, s);
        return enter(s, parent, ni + 1, 0, false);
      }
    }
    const next = row[c.off];
    if (next?.k === 'cmd' && next.name === name) return enter(next, c.path, c.off, 0, true);
    return place(root, c, cmd(name), c.off);
  }
  if (ch === '/') {
    // Pull the preceding term into the numerator. Scripts come along with their base,
    // but only if the base is itself a term: \lim_{x\to0} stays outside.
    let i = c.off;
    while (i > 0) {
      const n = row[i - 1];
      if (isScript(n)) {
        let b = i - 1;
        while (b > 0 && isScript(row[b - 1])) b--;
        if (b > 0 && isOperand(row[b - 1])) {
          i = b - 1;
          continue;
        }
        break;
      }
      if (!isOperand(n)) break;
      i--;
    }
    const num = row.splice(i, c.off - i);
    const frac = cmd('frac', 2);
    frac.slots[0] = num;
    row.splice(i, 0, frac);
    return enter(frac, c.path, i, num.length ? 1 : 0, false);
  }
  if (OPENERS[ch]) {
    const [open, close] = OPENERS[ch];
    return place(root, c, cmd('delim', 1, { open, close }), c.off);
  }
  if (ch === ' ') return c;
  if (/[a-zA-Z]/.test(ch)) {
    if (settings.instantKeywords) {
      const n = letterRun(root, c);
      const len = settledSuffix(text(row, c.off - n, c.off), ch);
      const kw = len ? keyword(text(row, c.off - len, c.off)) : null;
      if (kw) return typeChar(root, place(root, c, kw, c.off - len), ch);
    }
    row.splice(c.off, 0, sym(ch));
    const next = at(c.path, c.off + 1);
    return (settings.instantKeywords && instantWord(root, next)) || next;
  }
  const tex = { '{': '\\{', '}': '\\}', '%': '\\%', '#': '\\#', '&': '\\&', '~': '\\sim', '\\': '\\' }[ch] ?? ch;
  row.splice(c.off, 0, sym(tex));
  const next = at(c.path, c.off + 1);
  return (settings.instantKeywords && instantSymbols(root, next)) || autoReplace(root, next);
}

/** Space: complete a keyword, else jump out of the current slot when at its end. */
export function space(root: Row, c: Cursor): Cursor {
  if (isTextRow(root, c.path)) return typeChar(root, c, ' ');
  const done = completeWord(root, c, true);
  if (done) return done;
  if (c.path.length && c.off === rowAt(root, c.path).length) return moveRight(root, c) ?? c;
  return c;
}

export type BackspaceResult = Cursor | 'empty' | 'start';

export function backspace(root: Row, c: Cursor): BackspaceResult {
  const row = rowAt(root, c.path);
  if (c.off > 0) {
    const n = row[c.off - 1];
    if (n.k === 'cmd' && !isEmptyCmd(n)) return moveLeft(root, c)!;
    row.splice(c.off - 1, 1);
    return at(c.path, c.off - 1);
  }
  if (!c.path.length) return root.length ? 'start' : 'empty';
  const [ni, si] = c.path[c.path.length - 1];
  const parent = c.path.slice(0, -1);
  const owner = ownerOf(root, c.path)!;
  if (owner.name === 'matrix' && si > 0) return at([...parent, [ni, si - 1]], owner.slots[si - 1].length);
  // Dissolve the structure, keeping its contents in place.
  const before = owner.slots.slice(0, si).reduce((a, s) => a + s.length, 0);
  rowAt(root, parent).splice(ni, 1, ...owner.slots.flat());
  return at(parent, ni + before);
}

export function del(root: Row, c: Cursor): Cursor {
  const row = rowAt(root, c.path);
  if (c.off >= row.length) return c;
  const n = row[c.off];
  if (n.k === 'cmd' && !isEmptyCmd(n)) return moveRight(root, c)!;
  row.splice(c.off, 1);
  return c;
}

export function insertRow(root: Row, c: Cursor, nodes: Row): Cursor {
  const ins = clone(nodes);
  if (isTextRow(root, c.path)) {
    const flat: Row = [];
    const walk = (r: Row) => r.forEach((n) => (n.k === 'cmd' ? n.slots.forEach(walk) : flat.push(n)));
    walk(ins);
    rowAt(root, c.path).splice(c.off, 0, ...flat);
    return at(c.path, c.off + flat.length);
  }
  rowAt(root, c.path).splice(c.off, 0, ...ins);
  return at(c.path, c.off + ins.length);
}

export const endOf = (root: Row): Cursor => at([], root.length);
