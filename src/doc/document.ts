import { complete, generate } from '../ai';
import { type Dir, type IslandHost, MathIsland } from '../math/island';
import { parseTex, toTex } from '../math/latex';
import { type Cursor, pathKey, rowAt, sym } from '../math/model';
import { type ChangeKind, History, type Pos } from './history';
import { type Block, type Part, parseMarkdown, serializeInline, serializeMarkdown } from './markdown';

const ZW = '​';
const strip = (s: string) => s.replaceAll(ZW, '');
const EQ_MARK = '⟦EQ⟧';

type Leaf = Text | HTMLElement; // text node, inline math element, or <br>

export interface DocOptions {
  onChange(): void;
  prompt(anchor: DOMRect | null, label: string): Promise<string | null>;
  aiEnabled(): boolean;
}

export class DocEditor implements IslandHost {
  private islands = new WeakMap<Element, MathIsland>();
  private active: MathIsland | null = null;
  private history = new History();
  private ghostTimer = 0;
  private ghostAbort: AbortController | null = null;
  private busy = false; // a prompt is open; ignore blur

  constructor(
    readonly root: HTMLElement,
    private input: HTMLTextAreaElement,
    private opts: DocOptions,
  ) {
    root.contentEditable = 'true';
    root.spellcheck = false;
    root.addEventListener('mousedown', (e) => this.onMouseDown(e));
    root.addEventListener('keydown', (e) => this.onKeyDown(e));
    root.addEventListener('beforeinput', (e) => this.onBeforeInput(e));
    root.addEventListener('input', () => this.onInput());
    root.addEventListener('paste', (e) => this.onPaste(e));
    root.addEventListener('copy', (e) => this.onCopy(e, false));
    root.addEventListener('cut', (e) => this.onCopy(e, true));

    input.addEventListener('keydown', (e) => {
      if (this.active?.handleKey(e)) e.preventDefault();
    });
    const flush = () => {
      const v = input.value;
      input.value = '';
      if (v && this.active) this.active.typeText(v);
    };
    input.addEventListener('input', (e) => !(e as InputEvent).isComposing && flush());
    input.addEventListener('compositionend', flush);
    input.addEventListener('paste', (e) => {
      e.preventDefault();
      const t = e.clipboardData?.getData('text/plain') ?? '';
      this.active?.insertTex(t.trim().replace(/^\$+|\$+$/g, ''));
    });
    input.addEventListener('copy', (e) => {
      if (!this.active) return;
      e.preventDefault();
      e.clipboardData?.setData('text/plain', this.active.tex);
    });
    input.addEventListener('blur', () => {
      if (!this.busy && this.active && document.activeElement !== input) this.deactivate();
    });
    window.addEventListener('resize', () => this.active?.render());
  }

  // ---- load / save -------------------------------------------------------

  load(md: string, resetHistory = true) {
    this.active = null;
    this.root.replaceChildren(...parseMarkdown(md).map((b) => this.buildBlock(b)));
    this.ensureBlock();
    if (resetHistory) this.history.reset(this.markdown(), { b: 0, off: 0 });
  }

  markdown(marker?: MathIsland): string {
    return serializeMarkdown(this.blocks(marker));
  }

  private blocks(marker?: MathIsland): Block[] {
    return [...this.root.children].map((el): Block => {
      const isl = this.islands.get(el);
      if (isl) return { t: 'math', tex: isl === marker ? EQ_MARK : isl.tex };
      return { t: 'p', parts: this.inlineParts(el, marker) };
    });
  }

  private inlineParts(el: Node, marker?: MathIsland): Part[] {
    const parts: Part[] = [];
    const leaves = this.leaves(el);
    leaves.forEach((leaf, i) => {
      if (leaf instanceof Text) parts.push(strip(leaf.data));
      else if (leaf.tagName === 'BR') {
        if (i < leaves.length - 1) parts.push('\n');
      } else {
        const isl = this.islands.get(leaf);
        parts.push({ tex: isl === marker ? EQ_MARK : (isl?.tex ?? leaf.dataset.tex ?? '') });
      }
    });
    return parts;
  }

  private buildBlock(b: Block): HTMLElement {
    const el = document.createElement('div');
    if (b.t === 'math') {
      this.islands.set(el, new MathIsland(el, b.tex, true, this));
      return el;
    }
    el.className = 'blk';
    for (const p of b.parts) {
      if (typeof p === 'string') el.append(p);
      else el.append(this.makeInline(p.tex));
    }
    this.normalizeBlock(el);
    return el;
  }

  private makeInline(tex: string): HTMLElement {
    const span = document.createElement('span');
    this.islands.set(span, new MathIsland(span, tex, false, this));
    return span;
  }

  private newBlock(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'blk';
    el.append(document.createElement('br'));
    return el;
  }

  // ---- DOM structure -----------------------------------------------------

  private isMath = (n: Node | null): n is HTMLElement => n instanceof HTMLElement && this.islands.has(n);

  private leaves(el: Node): Leaf[] {
    const out: Leaf[] = [];
    const walk = (n: Node) => {
      for (const c of n.childNodes) {
        if (c instanceof Text) out.push(c);
        else if (c instanceof HTMLElement) {
          if (c.classList.contains('math') || c.tagName === 'BR') out.push(c);
          else walk(c);
        }
      }
    };
    walk(el);
    return out;
  }

  /** Text of a block without the rendered equations. */
  private plainText = (block: Node) => this.leaves(block).map((l) => (l instanceof Text ? strip(l.data) : '')).join('');

  private units = (leaf: Leaf) => (leaf instanceof Text ? strip(leaf.data).length : leaf.tagName === 'BR' ? 0 : 1);

  /** Keep a text node on both sides of every inline equation so the caret can sit there. */
  private normalizeBlock(block: HTMLElement) {
    if (this.islands.has(block)) return;
    for (const m of [...block.querySelectorAll<HTMLElement>('.math')]) {
      if (!this.isMath(m)) continue;
      const prev = m.previousSibling;
      if (!(prev instanceof Text) || !prev.data) m.before(ZW);
      const next = m.nextSibling;
      if (!(next instanceof Text) || !next.data) m.after(ZW);
    }
    const hasContent = this.leaves(block).some((l) => !(l instanceof Text) || l.data);
    if (!hasContent) block.replaceChildren(document.createElement('br'));
    const text = this.plainText(block);
    const h = /^(#{1,3}) /.exec(text);
    block.className = 'blk' + (h ? ` h${h[1].length}` : /^> /.test(text) ? ' quote' : '');
  }

  private ensureBlock() {
    if (!this.root.children.length) this.root.append(this.newBlock());
  }

  /** Repair whatever the browser did to the top-level structure. */
  private normalizeRoot() {
    let changed = false;
    let wrap: HTMLElement | null = null;
    for (const n of [...this.root.childNodes]) {
      const isBlock = n instanceof HTMLElement && (n.tagName === 'DIV' || n.tagName === 'P');
      if (isBlock) {
        wrap = null;
        if (!this.islands.has(n) && n.className.split(' ')[0] !== 'blk') {
          n.className = 'blk';
          changed = true;
        }
        continue;
      }
      if (n instanceof Text && !n.data) continue;
      if (!wrap) {
        wrap = document.createElement('div');
        wrap.className = 'blk';
        n.before(wrap);
      }
      wrap.append(n);
      changed = true;
    }
    this.ensureBlock();
    return changed;
  }

  private blockOf(n: Node | null): HTMLElement | null {
    while (n && n.parentNode !== this.root) n = n.parentNode;
    return n as HTMLElement | null;
  }

  private indexOfBlock = (b: Element) => [...this.root.children].indexOf(b);

  // ---- caret mapping -----------------------------------------------------

  private unitsBefore(block: HTMLElement, node: Node, offset: number): number {
    const caret = document.createRange();
    caret.setStart(node, offset);
    let n = 0;
    for (const leaf of this.leaves(block)) {
      if (leaf === node && leaf instanceof Text) return n + strip(leaf.data.slice(0, offset)).length;
      const r = document.createRange();
      r.setStartBefore(leaf);
      if (r.compareBoundaryPoints(Range.START_TO_START, caret) >= 0) return n;
      n += this.units(leaf);
    }
    return n;
  }

  private unitsOfIsland(isl: MathIsland): Pos {
    const block = this.blockOf(isl.el)!;
    const b = this.indexOfBlock(block);
    if (block === isl.el) return { b, off: 0 };
    const parent = isl.el.parentNode!;
    return { b, off: this.unitsBefore(block, parent, [...parent.childNodes].indexOf(isl.el)) };
  }

  getPos(): Pos | null {
    if (this.active?.cursor) return { ...this.unitsOfIsland(this.active), math: structuredClone(this.active.cursor) };
    const sel = getSelection();
    if (!sel?.rangeCount || !this.root.contains(sel.focusNode)) return null;
    const node = sel.focusNode!;
    if (node === this.root) return { b: Math.min(sel.focusOffset, this.root.children.length - 1), off: 0 };
    const block = this.blockOf(node)!;
    return { b: this.indexOfBlock(block), off: this.unitsBefore(block, node, sel.focusOffset) };
  }

  private islandAt(block: HTMLElement, off: number): MathIsland | null {
    if (this.islands.has(block)) return this.islands.get(block)!;
    let n = 0;
    for (const leaf of this.leaves(block)) {
      if (n === off && this.isMath(leaf)) return this.islands.get(leaf)!;
      n += this.units(leaf);
      if (n > off) break;
    }
    return null;
  }

  setPos(pos: Pos) {
    const block = (this.root.children[pos.b] ?? this.root.lastElementChild) as HTMLElement;
    if (pos.math) {
      const isl = this.islandAt(block, pos.off);
      if (isl) {
        let c: Cursor | 'end' = pos.math;
        try {
          if (rowAt(isl.root, c.path).length < c.off) c = 'end';
        } catch {
          c = 'end';
        }
        return this.activate(isl, c);
      }
    }
    this.deactivate();
    if (this.islands.has(block)) return this.caretAround(block, 'after');
    this.root.focus({ preventScroll: true });
    let n = 0;
    for (const leaf of this.leaves(block)) {
      if (leaf instanceof Text) {
        const len = strip(leaf.data).length;
        if (n + len >= pos.off) {
          let k = pos.off - n;
          let idx = 0;
          while (k > 0 || leaf.data[idx] === ZW) {
            if (idx >= leaf.data.length) break;
            if (leaf.data[idx] !== ZW) k--;
            idx++;
          }
          return this.setCaret(leaf, idx);
        }
        n += len;
      } else n += this.units(leaf);
    }
    const leaves = this.leaves(block);
    const last = leaves[leaves.length - 1];
    if (last instanceof Text) this.setCaret(last, last.data.length);
    else this.setCaret(block, last?.tagName === 'BR' ? block.childNodes.length - 1 : block.childNodes.length);
  }

  private setCaret(node: Node, offset: number) {
    const sel = getSelection()!;
    const r = document.createRange();
    r.setStart(node, offset);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
    (node instanceof Element ? node : node.parentElement)?.scrollIntoView?.({ block: 'nearest' });
  }

  /** Put the text caret before/after a display block, creating a paragraph if needed. */
  private caretAround(block: HTMLElement, side: 'before' | 'after') {
    let target = (side === 'after' ? block.nextElementSibling : block.previousElementSibling) as HTMLElement | null;
    if (!target || this.islands.has(target)) {
      target = this.newBlock();
      block[side](target);
    }
    this.root.focus({ preventScroll: true });
    const idx = this.indexOfBlock(target);
    this.setPos({ b: idx, off: side === 'after' ? 0 : Infinity });
  }

  // ---- math activation ---------------------------------------------------

  private activate(isl: MathIsland, where: Cursor | 'start' | 'end') {
    if (this.active && this.active !== isl) this.deactivate();
    this.active = isl;
    getSelection()?.removeAllRanges();
    isl.activate(where);
    const r = isl.el.getBoundingClientRect();
    Object.assign(this.input.style, { left: `${r.left + scrollX}px`, top: `${r.bottom + scrollY}px` });
    this.input.focus({ preventScroll: true });
    isl.el.scrollIntoView?.({ block: 'nearest' });
    this.history.record(this.markdown(), this.getPos(), 'struct');
  }

  private deactivate() {
    const isl = this.active;
    if (!isl) return;
    this.active = null;
    this.cancelGhost();
    isl.deactivate();
  }

  exit(isl: MathIsland, dir: Dir) {
    const pos = this.unitsOfIsland(isl);
    this.deactivate();
    this.root.focus({ preventScroll: true });
    if (isl.display) return this.caretAround(isl.el, dir === 'left' || dir === 'up' ? 'before' : 'after');
    this.setPos({ b: pos.b, off: dir === 'left' || dir === 'up' ? pos.off : pos.off + 1 });
  }

  remove(isl: MathIsland) {
    const pos = this.unitsOfIsland(isl);
    this.deactivate();
    if (isl.display) isl.el.replaceWith(this.newBlock());
    else {
      const block = this.blockOf(isl.el)!;
      isl.el.remove();
      block.normalize();
      this.normalizeBlock(block);
    }
    this.setPos({ b: pos.b, off: pos.off });
    this.record('struct');
  }

  changed(_isl: MathIsland) {
    this.record('math');
  }

  toDisplay(isl: MathIsland): boolean {
    const block = this.blockOf(isl.el)!;
    if (this.plainText(block).trim() || this.leaves(block).filter((l) => this.isMath(l)).length !== 1) return false;
    this.deactivate();
    const el = document.createElement('div');
    const disp = new MathIsland(el, '', true, this);
    this.islands.set(el, disp);
    block.replaceWith(el);
    this.activate(disp, 'start');
    this.record('struct');
    return true;
  }

  // ---- AI ------------------------------------------------------------------

  private cancelGhost() {
    clearTimeout(this.ghostTimer);
    this.ghostAbort?.abort();
    this.ghostAbort = null;
  }

  wantsCompletion(isl: MathIsland) {
    this.cancelGhost();
    if (!this.opts.aiEnabled() || !isl.cursor || !isl.root.length) return;
    this.ghostTimer = window.setTimeout(() => this.fetchGhost(isl), 450);
  }

  private async fetchGhost(isl: MathIsland) {
    const c = isl.cursor;
    if (!c || isl !== this.active) return;
    const key = isl.tex + '|' + pathKey(c.path) + ':' + c.off;
    // Split the equation's LaTeX at the cursor using a marker symbol.
    const probe = structuredClone(isl.root);
    rowAt(probe, c.path).splice(c.off, 0, sym('\\GNCURSOR'));
    const [before, after = ''] = toTex(probe).split('\\GNCURSOR');
    const ac = (this.ghostAbort = new AbortController());
    try {
      const text = await complete({ doc: this.markdown(isl), before: before.trim(), after: after.trim(), display: isl.display }, ac.signal);
      const now = isl.cursor;
      if (!now || isl !== this.active || key !== isl.tex + '|' + pathKey(now.path) + ':' + now.off) return;
      if (text) isl.setGhost(parseTex(text));
    } catch {
      /* status is reported by ai.ts */
    }
  }

  async commandK() {
    const pos = this.getPos();
    const target = this.active;
    const anchor = target ? target.el.getBoundingClientRect() : this.caretRect();
    this.busy = true;
    const instruction = await this.opts.prompt(anchor, target?.root.length ? 'Edit this equation…' : 'Describe an equation…');
    this.busy = false;
    if (!instruction) {
      if (pos) this.setPos(pos);
      return;
    }
    let display = false;
    let marker: MathIsland | undefined = target ?? undefined;
    let isl = target;
    if (!isl) {
      // Insert an empty equation where the caret was, so the model sees where it goes.
      if (pos) this.setPos(pos);
      const block = pos ? (this.root.children[pos.b] as HTMLElement) : null;
      display = !!block && !this.islands.has(block) && !this.plainText(block).trim();
      isl = this.insertIsland('', display);
      marker = isl ?? undefined;
    }
    if (!isl) return;
    isl.el.classList.add('loading');
    try {
      const tex = await generate({ doc: this.markdown(marker), current: target?.tex ?? '', instruction, display: isl.display });
      isl.setTex(tex);
      this.activate(isl, 'end');
      this.record('struct');
    } catch (e) {
      this.flash((e as Error).message);
      if (!isl.root.length && !target) this.remove(isl);
      else this.activate(isl, 'end');
    } finally {
      isl.el.classList.remove('loading');
    }
  }

  private flash(msg: string) {
    document.dispatchEvent(new CustomEvent('gn-flash', { detail: msg }));
  }

  private caretRect(): DOMRect | null {
    const sel = getSelection();
    if (!sel?.rangeCount) return null;
    const r = sel.getRangeAt(0).getBoundingClientRect();
    if (r.width || r.height) return r;
    const el = sel.focusNode instanceof Element ? sel.focusNode : sel.focusNode?.parentElement;
    return el?.getBoundingClientRect() ?? null;
  }

  // ---- history -----------------------------------------------------------

  private record(kind: ChangeKind) {
    this.history.record(this.markdown(), this.getPos(), kind);
    this.opts.onChange();
  }

  private restore(state: { md: string; pos: Pos | null } | null) {
    if (!state) return;
    this.cancelGhost();
    this.load(state.md, false);
    this.setPos(state.pos ?? { b: 0, off: 0 });
    this.opts.onChange();
  }

  undo() {
    this.restore(this.history.undo());
  }

  redo() {
    this.restore(this.history.redo());
  }

  // ---- text-mode events --------------------------------------------------

  private onMouseDown(e: MouseEvent) {
    const el = (e.target as Element).closest?.('.math');
    const isl = el && this.islands.get(el);
    if (isl) {
      e.preventDefault();
      this.activate(isl, isl.hitTest(e.clientX, e.clientY));
      return;
    }
    if (this.active) this.deactivate();
  }

  private collapsedPos(): (Pos & { block: HTMLElement }) | null {
    const sel = getSelection();
    if (!sel?.isCollapsed) return null;
    const pos = this.getPos();
    if (!pos) return null;
    return { ...pos, block: this.root.children[pos.b] as HTMLElement };
  }

  private blockLength = (block: HTMLElement) => this.leaves(block).reduce((a, l) => a + this.units(l), 0);

  private onKeyDown(e: KeyboardEvent) {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      return e.shiftKey ? this.redo() : this.undo();
    }
    if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      return this.redo();
    }
    if (mod && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      return void this.commandK();
    }
    if (mod || e.altKey) return;
    const p = this.collapsedPos();
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) document.execCommand('insertText', false, '\n');
      else this.splitBlock();
      return;
    }
    if (!p || e.shiftKey) return;
    const { block, off } = p;
    const prev = block.previousElementSibling as HTMLElement | null;
    const next = block.nextElementSibling as HTMLElement | null;
    const enter = (isl: MathIsland | null | undefined, where: 'start' | 'end') => {
      if (!isl) return false;
      e.preventDefault();
      this.activate(isl, where);
      return true;
    };
    switch (e.key) {
      case 'ArrowRight':
        if (enter(this.islandAt(block, off), 'start')) return;
        if (off === this.blockLength(block) && next) enter(this.islands.get(next), 'start');
        return;
      case 'ArrowLeft':
        if (off > 0 && enter(this.islandAt(block, off - 1), 'end')) return;
        if (off === 0 && prev) enter(this.islands.get(prev), 'end');
        return;
      case 'ArrowDown':
        if (next && this.islands.has(next) && this.onEdgeLine(block, 'bottom')) enter(this.islands.get(next), 'start');
        return;
      case 'ArrowUp':
        if (prev && this.islands.has(prev) && this.onEdgeLine(block, 'top')) enter(this.islands.get(prev), 'end');
        return;
      case 'Backspace':
        if (off > 0 && enter(this.islandAt(block, off - 1), 'end')) return;
        if (off === 0 && prev && this.islands.has(prev)) {
          if (!this.blockLength(block) && next) block.remove();
          enter(this.islands.get(prev), 'end');
        }
        return;
      case 'Delete':
        if (enter(this.islandAt(block, off), 'start')) return;
        if (off === this.blockLength(block) && next && this.islands.has(next)) enter(this.islands.get(next), 'start');
        return;
      case 'Tab':
        e.preventDefault();
        return;
    }
  }

  private onEdgeLine(block: HTMLElement, edge: 'top' | 'bottom'): boolean {
    const r = this.caretRect();
    if (!r) return true;
    const b = block.getBoundingClientRect();
    const lh = parseFloat(getComputedStyle(block).lineHeight) || 24;
    return edge === 'top' ? r.top - b.top < lh * 0.8 : b.bottom - r.bottom < lh * 0.8;
  }

  private splitBlock() {
    const sel = getSelection()!;
    if (!sel.rangeCount) return;
    if (!sel.isCollapsed) sel.deleteFromDocument();
    const pos = this.getPos();
    if (!pos) return;
    const block = this.root.children[pos.b] as HTMLElement;
    const r = sel.getRangeAt(0);
    r.setEndAfter(block.lastChild ?? block);
    const tail = r.extractContents();
    const nb = this.newBlock();
    nb.replaceChildren(tail);
    block.after(nb);
    this.normalizeBlock(block);
    this.normalizeBlock(nb);
    this.setPos({ b: pos.b + 1, off: 0 });
    this.record('struct');
  }

  /** Insert an equation at the text caret and return it (not yet activated for inline). */
  private insertIsland(tex: string, display: boolean): MathIsland | null {
    const sel = getSelection();
    if (!sel?.rangeCount) return null;
    if (!sel.isCollapsed) sel.deleteFromDocument();
    const pos = this.getPos();
    if (!pos) return null;
    const block = this.root.children[pos.b] as HTMLElement;
    let isl: MathIsland;
    if (display) {
      const el = document.createElement('div');
      isl = new MathIsland(el, tex, true, this);
      this.islands.set(el, isl);
      if (!this.plainText(block).trim() && !this.leaves(block).some((l) => this.isMath(l))) block.replaceWith(el);
      else block.after(el);
    } else {
      const span = this.makeInline(tex);
      isl = this.islands.get(span)!;
      const r = sel.getRangeAt(0);
      block.querySelector(':scope > br')?.remove();
      r.insertNode(span);
      this.normalizeBlock(block);
    }
    this.activate(isl, 'end');
    this.record('struct');
    return isl;
  }

  private onBeforeInput(e: InputEvent) {
    switch (e.inputType) {
      case 'historyUndo':
        e.preventDefault();
        return this.undo();
      case 'historyRedo':
        e.preventDefault();
        return this.redo();
      case 'insertParagraph':
        e.preventDefault();
        return this.splitBlock();
      case 'insertText':
        if (e.data === '$') {
          e.preventDefault();
          this.insertIsland('', false);
        }
        return;
    }
    if (e.inputType.startsWith('format')) e.preventDefault();
  }

  private onInput() {
    const pos = this.getPos();
    if (this.normalizeRoot() && pos) this.setPos(pos);
    const sel = getSelection();
    const block = this.blockOf(sel?.focusNode ?? null);
    if (block && block.parentNode === this.root) {
      this.normalizeBlock(block);
    }
    this.record('text');
  }

  private onPaste(e: ClipboardEvent) {
    e.preventDefault();
    const text = e.clipboardData?.getData('text/plain');
    if (!text) return;
    const sel = getSelection()!;
    if (!sel.isCollapsed) sel.deleteFromDocument();
    const blocks = parseMarkdown(text);
    if (!blocks.length) return;
    const pos = this.getPos();
    if (!pos) return;
    const r = sel.getRangeAt(0);
    const block = this.root.children[pos.b] as HTMLElement;
    if (blocks.length === 1 && blocks[0].t === 'p') {
      const frag = document.createDocumentFragment();
      for (const p of blocks[0].parts) frag.append(typeof p === 'string' ? p : this.makeInline(p.tex));
      const units = blocks[0].parts.reduce((a, p) => a + (typeof p === 'string' ? p.length : 1), 0);
      block.querySelector(':scope > br')?.remove();
      r.insertNode(frag);
      block.normalize();
      this.normalizeBlock(block);
      this.setPos({ b: pos.b, off: pos.off + units });
    } else {
      // Multi-block paste: split here and put the blocks in between.
      r.setEndAfter(block.lastChild ?? block);
      const tail = r.extractContents();
      const els = blocks.map((b) => this.buildBlock(b));
      block.after(...els);
      const nb = this.newBlock();
      nb.replaceChildren(tail);
      els[els.length - 1].after(nb);
      [block, nb].forEach((b) => this.normalizeBlock(b));
      if (!this.plainText(nb).trim() && !this.leaves(nb).some((l) => this.isMath(l)) && nb.nextElementSibling) nb.remove();
      this.setPos({ b: pos.b + els.length, off: Infinity });
    }
    this.record('struct');
  }

  private onCopy(e: ClipboardEvent, cut: boolean) {
    const sel = getSelection();
    if (!sel?.rangeCount || sel.isCollapsed) return;
    e.preventDefault();
    const frag = sel.getRangeAt(0).cloneContents();
    const holder = document.createElement('div');
    holder.append(frag);
    const parts: string[] = [];
    const blocks = [...holder.childNodes].some((n) => n instanceof HTMLElement && n.tagName === 'DIV');
    if (blocks) {
      for (const n of holder.childNodes) {
        if (n instanceof HTMLElement && n.classList.contains('display')) parts.push(`$$\n${n.dataset.tex ?? ''}\n$$`);
        else parts.push(serializeInline(this.inlineParts(n)));
      }
    } else parts.push(serializeInline(this.inlineParts(holder)));
    e.clipboardData?.setData('text/plain', parts.join('\n\n'));
    if (cut) {
      sel.deleteFromDocument();
      this.onInput();
    }
  }
}
