import katex from 'katex';
import { backspace, completeWord, del, endOf, insertRow, moveLeft, moveRight, space, typeChar, verticalTarget } from './editing';
import { parseTex, type RenderMap, toInstrumentedTex, toTex } from './latex';
import { type Cursor, isTextRow, pathKey, type Row, rowAt, type Step } from './model';

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

export class MathIsland {
  root: Row;
  cursor: Cursor | null = null;
  ghost: Row | null = null;
  readonly content: HTMLElement;
  readonly caret: HTMLElement;
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
    const { tex, map } = toInstrumentedTex(this.root, this.cursor, this.ghost, this.display);
    this.map = map;
    const opts = { displayMode: this.display, trust: true, strict: 'ignore' as const, output: 'html' as const };
    try {
      katex.render(tex, this.content, { ...opts, throwOnError: true });
      this.el.classList.remove('error');
    } catch {
      katex.render(toTex(this.root), this.content, { ...opts, throwOnError: false });
      this.el.classList.add('error');
    }
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
  private stops(info: RowInfo): number[] {
    if (info.empty !== undefined) {
      const b = this.box(info.empty, 'e');
      return [b ? b.left : 0];
    }
    const boxes = info.ids.map((id) => this.box(id));
    const xs: number[] = [];
    for (let i = 0; i <= boxes.length; i++) {
      const l = boxes[i - 1];
      const r = boxes[i];
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
    const pick = [c.off - 1, c.off].filter((i) => i >= 0 && i < row.length);
    const best = pick.find((i) => row[i].k === 'sym') ?? pick[0];
    const b = best === undefined ? null : this.box(info.ids[best]);
    return b && { left: x, right: x, top: b.top, bottom: b.bottom };
  }

  private placeCaret() {
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
    this.ghost = null;
    this.render();
  }

  setGhost(g: Row | null) {
    this.ghost = g?.length ? g : null;
    this.render();
  }

  acceptGhost() {
    if (!this.ghost || !this.cursor) return;
    this.cursor = insertRow(this.root, this.cursor, this.ghost);
    this.ghost = null;
    this.commit(false);
  }

  insertTex(tex: string) {
    if (!this.cursor) return;
    this.cursor = insertRow(this.root, this.cursor, parseTex(tex));
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

  typeText(text: string) {
    if (!this.cursor) return;
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
      else return false;
      return true;
    }
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', 'Escape', 'Home', 'End', '$'].includes(e.key) || (e.key === 'Tab' && !this.ghost)) {
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
          const done = isTextRow(this.root, c.path) ? null : completeWord(this.root, c, true);
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
