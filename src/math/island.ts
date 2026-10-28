import katex from 'katex';
import { backspace, completeWord, del, deleteRange, endOf, extendLeft, extendRight, insertRow, moveLeft, moveRight, type Range, rangeNodes, selectionRange, space, typeChar, verticalTarget, wrapRange } from './editing';
import { bareDelim, parseTex, type RenderMap, toInstrumentedTex, toTex } from './latex';
import { type Cursor, isScript, isTextRow, ownerOf, pathKey, type Row, rowAt, type Step } from './model';

export type Dir = 'left' | 'right' | 'up' | 'down';

export interface IslandHost {
  exit(island: MathIsland, dir: Dir): void;
  remove(island: MathIsland): void;
  changed(island: MathIsland): void;
  wantsCompletion(island: MathIsland): void;
  toDisplay(island: MathIsland): boolean;
  commandK(): void;
  undo(): void;
  redo(): void;
}

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}
interface RowInfo {
  path: Step[];
  ids: number[]; // node ids in row order
  empty?: number; // placeholder id for empty rows
}

// Explicit fields: DOMRect properties are prototype getters, so spreading one yields {}.
const union = (a: Box | null, b: Box): Box =>
  a
    ? { left: Math.min(a.left, b.left), right: Math.max(a.right, b.right), top: Math.min(a.top, b.top), bottom: Math.max(a.bottom, b.bottom) }
    : { left: b.left, right: b.right, top: b.top, bottom: b.bottom };

const INK = '.frac-line, .overline-line, .underline-line, svg, .hline, .rule';

/** Tight box around what an element actually draws (KaTeX struts would inflate getBoundingClientRect). */
function inkBox(el: Element): Box | null {
  let box: Box | null = null;
  const range = document.createRange();
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    if (!t.textContent?.trim()) continue;
    range.selectNodeContents(t);
    const r = range.getBoundingClientRect();
    if (r.width || r.height) box = union(box, r);
  }
  const extra = el.matches(INK) ? [el] : [...el.querySelectorAll(INK)];
  for (const e of extra) {
    const r = e.getBoundingClientRect();
    if (r.width || r.height) box = union(box, r);
  }
  if (!box) {
    const r = el.getBoundingClientRect();
    if (r.width || r.height) box = { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  }
  return box;
}

/**
 * Insert nodes at the cursor. A lone closing bracket that matches the bracket the cursor is in
 * (a completion of "(a+" that ends in "b)") steps out of it instead of being inserted.
 */
function insertWithClosers(root: Row, c: Cursor, nodes: Row): Cursor {
  const owner = ownerOf(root, c.path);
  const j = owner?.name === 'delim' ? nodes.findIndex((n) => n.k === 'sym' && bareDelim(n.tex) === owner.close) : -1;
  if (j < 0) return insertRow(root, c, nodes);
  insertRow(root, c, nodes.slice(0, j));
  const parent = c.path.slice(0, -1);
  const after: Cursor = { path: parent, off: c.path[c.path.length - 1][0] + 1 };
  return insertWithClosers(root, after, nodes.slice(j + 1));
}

export class MathIsland {
  root: Row;
  cursor: Cursor | null = null;
  ghost: Row | null = null;
  /** Selection anchor; the selection runs from here to `cursor`. */
  anchor: Cursor | null = null;
  readonly content: HTMLElement;
  readonly caret: HTMLElement;
  private readonly selBox: HTMLElement;
  private map: RenderMap = { nodes: [], rows: [] };
  private rows = new Map<string, RowInfo>();
  private els = new Map<string, Element>();

  constructor(
    readonly el: HTMLElement,
    tex: string,
    readonly display: boolean,
    private host: IslandHost,
  ) {
    this.root = parseTex(tex);
    el.className = display ? 'math display' : 'math';
    el.contentEditable = 'false';
    el.replaceChildren();
    this.selBox = el.appendChild(document.createElement('span'));
    this.selBox.className = 'm-sel';
    this.content = el.appendChild(document.createElement('span'));
    this.caret = el.appendChild(document.createElement('span'));
    this.caret.className = 'm-caret';
    this.render();
  }

  get tex() {
    return toTex(this.root);
  }

  setTex(tex: string) {
    this.root = parseTex(tex);
    this.cursor = this.cursor && endOf(this.root);
    this.ghost = null;
    this.render();
  }

  render() {
    const opts = { displayMode: this.display, trust: true, strict: 'ignore' as const, output: 'html' as const };
    // Instrumented render; if KaTeX rejects a wrapped construct, retry with risky pieces unwrapped
    // (still editable), and only show the error state if even plain LaTeX fails.
    let map: RenderMap | null = null;
    for (const safe of [false, true]) {
      const r = toInstrumentedTex(this.root, this.cursor, this.ghost, this.display, safe);
      try {
        katex.render(r.tex, this.content, { ...opts, throwOnError: true });
        map = r.map;
        break;
      } catch {
        /* try the next mode */
      }
    }
    this.el.classList.toggle('error', !map);
    if (!map) {
      map = { nodes: [], rows: [] };
      katex.render(toTex(this.root), this.content, { ...opts, throwOnError: false });
    }
    this.map = map;
    this.rows.clear();
    this.els.clear();
    map.nodes.forEach(({ path }, id) => {
      const k = pathKey(path);
      if (!this.rows.has(k)) this.rows.set(k, { path, ids: [] });
      this.rows.get(k)!.ids.push(id);
    });
    map.rows.forEach((path, id) => this.rows.set(pathKey(path), { path, ids: [], empty: id }));
    this.content.querySelectorAll('[data-n]').forEach((e) => this.els.set('n' + (e as HTMLElement).dataset.n, e));
    this.content.querySelectorAll('[data-e]').forEach((e) => this.els.set('e' + (e as HTMLElement).dataset.e, e));
    this.el.classList.toggle('active', !!this.cursor);
    this.el.dataset.tex = toTex(this.root);
    this.placeCaret();
  }

  // ---- geometry ----------------------------------------------------------

  private box(id: number, kind: 'n' | 'e' = 'n'): Box | null {
    const e = this.els.get(kind + id);
    return e ? inkBox(e) : null;
  }

  private rowBox(info: RowInfo): Box | null {
    if (info.empty !== undefined) return this.box(info.empty, 'e');
    let b: Box | null = null;
    for (const id of info.ids) {
      const r = this.box(id);
      if (r) b = union(b, r);
    }
    return b;
  }

  /** Caret x for every offset in a row. */
  /**
   * A base and its trailing scripts (e.g. \sum with limits) are drawn as one
   * unit, so gaps around them are measured against the whole group.
   */
  private groups(row: Row): { start: number; end: number }[] {
    const g: { start: number; end: number }[] = [];
    row.forEach((n, i) => {
      if (isScript(n) && i > 0) {
        const prev = g[i - 1];
        g.push(prev);
        prev.end = i;
      } else g.push({ start: i, end: i });
    });
    return g;
  }

  /** Caret x for every offset in a row. */
  private stops(info: RowInfo): number[] {
    if (info.empty !== undefined) {
      const b = this.box(info.empty, 'e');
      return [b ? b.left : 0];
    }
    const row = rowAt(this.root, info.path);
    const boxes = info.ids.map((id) => this.box(id));
    const groups = this.groups(row);
    const groupBox = (i: number) => {
      let b: Box | null = null;
      for (let j = groups[i].start; j <= groups[i].end; j++) if (boxes[j]) b = union(b, boxes[j]!);
      return b;
    };
    const xs: number[] = [];
    for (let i = 0; i <= boxes.length; i++) {
      if (i > 0 && i < boxes.length && groups[i - 1] === groups[i]) {
        // Between a base and its scripts: where the scripts attach.
        const base = boxes[groups[i].start];
        xs.push(base ? base.right : 0);
        continue;
      }
      const l = i > 0 ? groupBox(i - 1) : null;
      const r = i < boxes.length ? groupBox(i) : null;
      xs.push(l && r ? (l.right + r.left) / 2 : l ? l.right : r ? r.left : 0);
    }
    return xs;
  }

  private caretBox(c: Cursor): Box | null {
    const info = this.rows.get(pathKey(c.path));
    if (!info) return null;
    const ghostEl = this.ghost?.length ? this.content.querySelector('.gn-ghost') : null;
    if (ghostEl) {
      const g = inkBox(ghostEl);
      if (g) return { ...g, right: g.left }; // g is a plain Box from union()
    }
    if (info.empty !== undefined) {
      const b = this.box(info.empty, 'e');
      return b && { ...b, right: b.left };
    }
    const x = this.stops(info)[c.off];
    const row = rowAt(this.root, c.path);
    const groups = this.groups(row);
    // Size the caret from a neighbouring base symbol, not a raised script.
    const pick = [c.off - 1, c.off].filter((i) => i >= 0 && i < row.length).map((i) => groups[i].start);
    const best = pick.find((i) => row[i].k === 'sym') ?? pick[0];
    const b = best === undefined ? null : this.box(info.ids[best]);
    return b && { left: x, right: x, top: b.top, bottom: b.bottom };
  }

  private placeSelection() {
    const r = this.selection();
    const info = r && this.rows.get(pathKey(r.path));
    if (!r || !info || info.empty !== undefined) {
      this.selBox.style.display = 'none';
      return;
    }
    const xs = this.stops(info);
    let top = Infinity;
    let bottom = -Infinity;
    for (let i = r.lo; i < r.hi; i++) {
      const b = this.box(info.ids[i]);
      if (b) [top, bottom] = [Math.min(top, b.top), Math.max(bottom, b.bottom)];
    }
    if (top === Infinity) return void (this.selBox.style.display = 'none');
    const o = this.el.getBoundingClientRect();
    Object.assign(this.selBox.style, {
      display: 'block',
      left: `${xs[r.lo] - o.left}px`,
      width: `${Math.max(xs[r.hi] - xs[r.lo], 2)}px`,
      top: `${top - o.top - 1}px`,
      height: `${bottom - top + 2}px`,
    });
  }

  private placeCaret() {
    this.placeSelection();
    const b = this.cursor && this.caretBox(this.cursor);
    if (!b) {
      this.caret.style.display = 'none';
      return;
    }
    const o = this.el.getBoundingClientRect();
    const h = Math.max(b.bottom - b.top, 10);
    const mid = (b.top + b.bottom) / 2;
    Object.assign(this.caret.style, {
      display: 'block',
      left: `${b.left - o.left - 0.75}px`,
      top: `${mid - h / 2 - o.top}px`,
      height: `${h}px`,
    });
    // restart blink
    this.caret.style.animation = 'none';
    void this.caret.offsetWidth;
    this.caret.style.animation = '';
  }

  caretRect(): Box | null {
    return this.cursor && this.caretBox(this.cursor);
  }

  /** Map a viewport point to the nearest model position. */
  hitTest(px: number, py: number): Cursor {
    let best: { info: RowInfo; area: number; dist: number } | null = null;
    for (const info of this.rows.values()) {
      const b = this.rowBox(info);
      if (!b) continue;
      const pad = 2;
      const dx = Math.max(b.left - pad - px, 0, px - b.right - pad);
      const dy = Math.max(b.top - pad - py, 0, py - b.bottom - pad);
      const dist = dx + dy;
      const area = (b.right - b.left) * (b.bottom - b.top);
      if (!best || dist < best.dist - 0.5 || (Math.abs(dist - best.dist) <= 0.5 && area < best.area)) best = { info, area, dist };
    }
    if (!best) return endOf(this.root);
    const xs = this.stops(best.info);
    let off = 0;
    xs.forEach((x, i) => {
      if (Math.abs(x - px) < Math.abs(xs[off] - px)) off = i;
    });
    return { path: best.info.path, off };
  }

  // ---- editing -----------------------------------------------------------

  activate(c: Cursor | 'start' | 'end') {
    this.cursor = c === 'start' ? { path: [], off: 0 } : c === 'end' ? endOf(this.root) : c;
    this.anchor = null;
    this.render();
  }

  /** Convert a keyword left pending before the cursor (e.g. "beta" then arrow out). */
  private finishWord() {
    if (!this.cursor || isTextRow(this.root, this.cursor.path)) return;
    const done = completeWord(this.root, this.cursor, false);
    if (done) {
      this.cursor = done;
      this.host.changed(this);
    }
  }

  deactivate() {
    this.finishWord();
    this.cursor = null;
    this.anchor = null;
    this.ghost = null;
    this.render();
  }

  setGhost(g: Row | null) {
    this.ghost = g?.length ? g : null;
    this.render();
  }

  acceptGhost() {
    if (!this.ghost || !this.cursor) return;
    this.cursor = insertWithClosers(this.root, this.cursor, this.ghost);
    this.ghost = null;
    this.commit(false);
  }

  insertTex(tex: string) {
    if (!this.cursor) return;
    this.deleteSelection();
    this.cursor = insertWithClosers(this.root, this.cursor!, parseTex(tex));
    this.commit();
  }

  private commit(complete = true) {
    this.render();
    this.host.changed(this);
    if (complete) this.host.wantsCompletion(this);
  }

  private move(next: Cursor | null, dir: Dir) {
    this.ghost = null;
    if (next) {
      this.cursor = next;
      this.render();
    } else this.host.exit(this, dir);
  }

  private vertical(dir: -1 | 1) {
    const c = this.cursor!;
    const target = verticalTarget(this.root, c, dir);
    if (!target) return this.host.exit(this, dir < 0 ? 'up' : 'down');
    const x = this.caretRect()?.left ?? 0;
    const info = this.rows.get(pathKey(target));
    const xs = info ? this.stops(info) : [0];
    let off = 0;
    xs.forEach((v, i) => {
      if (Math.abs(v - x) < Math.abs(xs[off] - x)) off = i;
    });
    this.move({ path: target, off }, 'up');
  }

  // ---- selection ---------------------------------------------------------

  selection(): Range | null {
    return this.anchor && this.cursor ? selectionRange(this.anchor, this.cursor) : null;
  }

  /** LaTeX of the selection, or null if nothing is selected. */
  selectedTex(): string | null {
    const r = this.selection();
    return r ? toTex(rangeNodes(this.root, r)) : null;
  }

  /** Move the selection's moving end (mouse drag, shift+click). */
  extendTo(c: Cursor) {
    this.anchor ??= this.cursor && structuredClone(this.cursor);
    this.cursor = c;
    this.ghost = null;
    this.render();
  }

  selectAll() {
    this.anchor = { path: [], off: 0 };
    this.cursor = endOf(this.root);
    this.ghost = null;
    this.render();
  }

  /** Delete the selection (if any) and return whether there was one. */
  deleteSelection(): boolean {
    const r = this.selection();
    this.anchor = null;
    if (!r) return false;
    this.cursor = deleteRange(this.root, r);
    return true;
  }

  /** Cut: delete the selection as one undoable edit. */
  removeSelection() {
    if (this.deleteSelection()) this.commit();
  }

  private collapse(to: 'lo' | 'hi') {
    const r = this.selection()!;
    this.anchor = null;
    this.move({ path: r.path, off: r[to] }, 'right');
  }

  typeText(text: string) {
    if (!this.cursor) return;
    const r = this.selection();
    if (r) {
      this.anchor = null;
      this.ghost = null;
      if (text[0] === '(' || text[0] === '/') {
        this.cursor = wrapRange(this.root, r, text[0]);
        text = text.slice(1);
      } else this.cursor = deleteRange(this.root, r);
      if (!text) return this.commit();
    }
    for (const ch of text) {
      if (ch === '$') return this.host.exit(this, 'right');
      const g = this.ghost;
      const consumes = g?.[0]?.k === 'sym' && g[0].tex === ch && /^[\w+\-=,.]$/.test(ch);
      this.cursor = ch === ' ' ? space(this.root, this.cursor) : typeChar(this.root, this.cursor, ch);
      this.ghost = consumes && g!.length > 1 ? g!.slice(1) : null;
    }
    this.commit(!this.ghost);
  }

  /** Returns true if the key was handled. */
  handleKey(e: KeyboardEvent): boolean {
    if (!this.cursor) return false;
    const mod = e.metaKey || e.ctrlKey;
    if (mod) {
      const k = e.key.toLowerCase();
      if (k === 'z') e.shiftKey ? this.host.redo() : this.host.undo();
      else if (k === 'y') this.host.redo();
      else if (k === 'k') this.host.commandK();
      else if (k === 'a') this.selectAll();
      else return false;
      return true;
    }
    if (e.shiftKey && ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
      this.finishWord();
      const c = this.cursor!;
      this.anchor ??= structuredClone(c);
      if (e.key === 'ArrowLeft') this.cursor = extendLeft(this.root, c);
      else if (e.key === 'ArrowRight') this.cursor = extendRight(this.root, c);
      else if (e.key === 'Home') this.cursor = { path: [], off: 0 };
      else if (e.key === 'End') this.cursor = endOf(this.root);
      this.ghost = null;
      this.render();
      return true;
    }
    const sel = this.selection();
    if (sel) {
      switch (e.key) {
        case 'ArrowLeft':
        case 'ArrowUp':
        case 'Home':
          this.collapse('lo');
          return true;
        case 'ArrowRight':
        case 'ArrowDown':
        case 'End':
          this.collapse('hi');
          return true;
        case 'Backspace':
        case 'Delete':
          this.deleteSelection();
          this.commit();
          return true;
        case 'Escape':
          this.anchor = null;
          this.render();
          return true;
        case 'Tab':
        case 'Enter':
          this.anchor = null;
          break;
      }
    } else this.anchor = null;
    // Tab converts a pending word itself (and then stays put), so it isn't in this list.
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', 'Escape', 'Home', 'End', '$'].includes(e.key)) {
      if (e.key !== 'Escape' || !this.ghost) this.finishWord();
    }
    const c = this.cursor;
    switch (e.key) {
      case 'ArrowLeft':
        this.move(moveLeft(this.root, c), 'left');
        return true;
      case 'ArrowRight':
        this.move(moveRight(this.root, c), 'right');
        return true;
      case 'ArrowUp':
        this.vertical(-1);
        return true;
      case 'ArrowDown':
        this.vertical(1);
        return true;
      case 'Home':
        this.move({ path: [], off: 0 }, 'left');
        return true;
      case 'End':
        this.move(endOf(this.root), 'right');
        return true;
      case 'Backspace': {
        this.ghost = null;
        const r = backspace(this.root, c);
        if (r === 'empty') this.host.remove(this);
        else if (r === 'start') this.host.exit(this, 'left');
        else {
          this.cursor = r;
          this.commit();
        }
        return true;
      }
      case 'Delete':
        this.ghost = null;
        this.cursor = del(this.root, c);
        this.commit();
        return true;
      case 'Tab':
        if (this.ghost) this.acceptGhost();
        else if (!e.shiftKey) {
          const done = isTextRow(this.root, c.path) ? null : completeWord(this.root, c, true, true);
          if (done) {
            this.cursor = done;
            this.commit();
          } else this.move(moveRight(this.root, c), 'right');
        } else this.move(moveLeft(this.root, c), 'left');
        return true;
      case 'Enter':
        this.ghost = null;
        this.host.exit(this, this.display ? 'down' : 'right');
        return true;
      case 'Escape':
        if (this.ghost) this.setGhost(null);
        else this.host.exit(this, 'right');
        return true;
      case '$':
        if (!this.root.length && !this.display && this.host.toDisplay(this)) return true;
        this.host.exit(this, 'right');
        return true;
    }
    if (e.key.length === 1 && !e.altKey) {
      this.typeText(e.key);
      return true;
    }
    if (e.key.length === 1 && e.altKey) {
      // Option-combos produce real characters on macOS (e.g. AZERTY brackets): let input handle them.
      return false;
    }
    return false;
  }
}
