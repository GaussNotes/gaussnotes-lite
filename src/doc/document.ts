import { cleanLatex, complete, generate } from '../ai';
import { type Dir, type IslandHost, MathIsland } from '../math/island';
import { parseTex, toTex } from '../math/latex';
import { type Cursor, pathKey, rowAt, sym } from '../math/model';
import { type ChangeKind, History, type Pos } from './history';
import { ISLAND, parseBlock, renderToks } from './inline';
import { type Block, type Part, parseMarkdown, serializeInline, serializeMarkdown } from './markdown';

const ZW = '​';
const strip = (s: string) => s.replaceAll(ZW, '');
const EQ_MARK = '⟦EQ⟧';
/** Clipboard type marking LaTeX copied from an equation, so pasting it into text makes an equation again. */
const TEX_MIME = 'application/x-gaussnotes-tex';

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
    // Don't rebuild a paragraph mid-composition (IME, dead keys): it would cancel the composition.
    root.addEventListener('input', (e) => !(e as InputEvent).isComposing && this.onInput());
    root.addEventListener('compositionend', () => this.onInput());
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
      const t = e.clipboardData?.getData(TEX_MIME) || e.clipboardData?.getData('text/plain') || '';
      this.active?.insertTex(cleanLatex(t));
    });
    // Copy/cut inside an equation: the selection (or the whole equation) as plain LaTeX.
    const copyTex = (e: ClipboardEvent, cut: boolean) => {
      if (!this.active) return;
      e.preventDefault();
      const tex = this.active.selectedTex() ?? this.active.tex;
      e.clipboardData?.setData('text/plain', tex);
      e.clipboardData?.setData(TEX_MIME, tex);
      if (cut) this.active.removeSelection();
    };
    input.addEventListener('copy', (e) => copyTex(e, false));
    input.addEventListener('cut', (e) => copyTex(e, true));
    input.addEventListener('blur', () => {
      if (!this.busy && this.active && document.activeElement !== input) this.deactivate();
    });
    window.addEventListener('resize', () => this.active?.render());
    // The paragraph holding the caret shows its markdown markers; the others show just the result.
    document.addEventListener('selectionchange', () => this.markEditing());
    // selectionchange can lag or be skipped (e.g. unfocused windows); these keep the marker state honest.
    for (const ev of ['keyup', 'mouseup', 'focus', 'input'] as const) root.addEventListener(ev, () => this.markEditing());
  }

  private editing: HTMLElement | null = null;
  private markEditing() {
    const sel = getSelection();
    const node = sel?.rangeCount && this.root.contains(sel.focusNode) ? sel.focusNode : null;
    const block = node ? this.blockOf(node) : null;
    if (block === this.editing) return;
    this.editing?.classList.remove('editing');
    this.editing = block && !this.islands.has(block) ? block : null;
    this.editing?.classList.add('editing');
  }

  // ---- load / save -------------------------------------------------------

  load(md: string, resetHistory = true) {
    this.active = null;
    this.root.replaceChildren(...parseMarkdown(md).map((b) => this.buildBlock(b)));
    this.ensureBlock();
    this.editing = null;
    this.renumberFootnotes();
    if (resetHistory) this.history.reset(this.markdown(), { b: 0, off: 0 });
    this.opts.onChange();
  }

  /** Headings up to `maxLevel`, as displayed (markers removed, equations as rendered text). */
  headings(maxLevel = 2): { index: number; level: number; text: string; secnum?: string; el: HTMLElement; content: Node[] }[] {
    return [...this.root.children].flatMap((el, index) => {
      const m = /\bh([1-6])\b/.exec(el.className);
      if (!m || +m[1] > maxLevel) return [];
      const copy = el.cloneNode(true) as HTMLElement;
      copy.querySelectorAll('.md-mark, .m-caret, .m-sel').forEach((e) => e.remove());
      const text = strip(copy.textContent ?? '').trim();
      // Rendered copy for display (equations keep their KaTeX rendering), not editable.
      copy.querySelectorAll('[contenteditable]').forEach((e) => e.removeAttribute('contenteditable'));
      copy.querySelectorAll('.math').forEach((e) => e.classList.remove('active'));
      return [{ index, level: +m[1], text, secnum: (el as HTMLElement).dataset.secnum, el: el as HTMLElement, content: [...copy.childNodes] }];
    });
  }

  /** Jump to a block: caret at its end, block scrolled to the top. */
  goTo(index: number) {
    const el = this.root.children[index];
    if (!el) return;
    this.setPos({ b: index, off: Infinity });
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
  /** The paragraph's text with ISLAND where each equation sits, plus those equation elements. */
  private blockSource(block: HTMLElement): { src: string; islands: HTMLElement[] } {
    let src = '';
    const islands: HTMLElement[] = [];
    for (const leaf of this.leaves(block)) {
      if (leaf instanceof Text) src += strip(leaf.data);
      else if (leaf.tagName !== 'BR') {
        src += ISLAND;
        islands.push(leaf);
      }
    }
    return { src, islands };
  }

  /**
   * Rebuild a paragraph's DOM from its text: inline markdown decorations, heading/quote/footnote
   * classes, and a text node on both sides of every equation so the caret can sit there.
   * The caret is kept by its text offset.
   */
  private normalizeBlock(block: HTMLElement, src = this.blockSource(block)) {
    if (this.islands.has(block)) return;
    const sel = getSelection();
    const keep = !this.active && !!sel?.rangeCount && block.contains(sel.anchorNode) && block.contains(sel.focusNode);
    const a = keep ? this.unitsBefore(block, sel!.anchorNode!, sel!.anchorOffset) : 0;
    const f = keep ? this.unitsBefore(block, sel!.focusNode!, sel!.focusOffset) : 0;

    const info = parseBlock(src.src);
    block.replaceChildren(renderToks(info.toks, [...src.islands]));
    for (const m of [...block.querySelectorAll<HTMLElement>('.math')]) {
      if (!this.isMath(m)) continue;
      const prev = m.previousSibling;
      if (!(prev instanceof Text) || !prev.data) m.before(ZW);
      const next = m.nextSibling;
      if (!(next instanceof Text) || !next.data) m.after(ZW);
    }
    if (!src.src) block.replaceChildren(document.createElement('br'));
    const editing = block.classList.contains('editing');
    block.className =
      'blk' + (info.heading ? ` h${info.heading}` : '') + (info.unnumbered ? ' unnumbered' : '') + (info.quote ? ' quote' : '') + (info.fnDef ? ' fn-def' : '') + (editing ? ' editing' : '');
    if (info.fnDef) block.dataset.label = info.fnDef;
    else delete block.dataset.label;
    if (keep) this.setRange(block, a, f);
  }

  /** Section numbers like Pandoc's --number-sections: each level counts within the one above; {-} headings are skipped. */
  private numberHeadings() {
    const count = [0, 0, 0, 0, 0, 0];
    for (const b of this.root.querySelectorAll<HTMLElement>('.blk')) {
      const level = +(/\bh([1-6])\b/.exec(b.className)?.[1] ?? 0);
      if (!level || b.classList.contains('unnumbered')) {
        delete b.dataset.secnum;
        continue;
      }
      count[level - 1]++;
      count.fill(0, level);
      // Pandoc keeps leading zeros for skipped levels (### right after # is 1.0.1).
      b.dataset.secnum = count.slice(0, level).join('.');
    }
  }

  /** Number footnotes in order of first appearance, like Pandoc, and put each note's text on hover. */
  private renumberFootnotes() {
    this.numberHeadings();
    const num = new Map<string, number>();
    let n = 0;
    for (const el of this.root.querySelectorAll<HTMLElement>('.blk:not(.fn-def) .md-fnref, .blk:not(.fn-def) .md-fninline')) {
      if (el.classList.contains('md-fninline')) {
        el.dataset.n = String(++n);
        el.title = (el.querySelector('.md-fnbody')?.textContent ?? '').trim();
      } else {
        const label = el.dataset.label!;
        if (!num.has(label)) num.set(label, ++n);
        el.dataset.n = String(num.get(label));
      }
    }
    const text = new Map<string, string>();
    for (const def of this.root.querySelectorAll<HTMLElement>('.blk.fn-def')) {
      const label = def.dataset.label!;
      if (!num.has(label)) num.set(label, ++n);
      def.dataset.n = String(num.get(label));
      text.set(label, this.plainText(def).replace(/^\[\^[^\]]+\]:\s?/, ''));
    }
    for (const el of this.root.querySelectorAll<HTMLElement>('.md-fnref')) {
      el.title = text.get(el.dataset.label!) ?? `No definition for [^${el.dataset.label}]`;
      el.classList.toggle('missing', !text.has(el.dataset.label!));
    }
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
    if (node === this.root) {
      // Caret between blocks (e.g. a click below the last paragraph): snap into the nearest one.
      const n = this.root.children.length;
      return sel.focusOffset >= n ? { b: n - 1, off: Infinity } : { b: sel.focusOffset, off: 0 };
    }
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
    const [node, idx] = this.domAt(block, pos.off);
    this.setCaret(node, idx);
  }

  /** DOM position for a text offset (in units) in a paragraph. */
  private domAt(block: HTMLElement, off: number): [Node, number] {
    let n = 0;
    for (const leaf of this.leaves(block)) {
      if (leaf instanceof Text) {
        const len = strip(leaf.data).length;
        if (n + len >= off) {
          let k = off - n;
          let idx = 0;
          while (k > 0 || leaf.data[idx] === ZW) {
            if (idx >= leaf.data.length) break;
            if (leaf.data[idx] !== ZW) k--;
            idx++;
          }
          return [leaf, idx];
        }
        n += len;
      } else n += this.units(leaf);
    }
    const leaves = this.leaves(block);
    const last = leaves[leaves.length - 1];
    if (last instanceof Text) return [last, last.data.length];
    return [block, last?.tagName === 'BR' ? block.childNodes.length - 1 : block.childNodes.length];
  }

  /** Select text offsets [anchor, focus] in a paragraph. */
  private setRange(block: HTMLElement, anchor: number, focus: number) {
    const sel = getSelection()!;
    const [an, ao] = this.domAt(block, anchor);
    const [fn, fo] = this.domAt(block, focus);
    sel.setBaseAndExtent(an, ao, fn, fo);
    this.markEditing();
  }

  private setCaret(node: Node, offset: number) {
    const sel = getSelection()!;
    const r = document.createRange();
    r.setStart(node, offset);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
    this.markEditing();
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
    this.renumberFootnotes();
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
    const link = (e.target as Element).closest?.<HTMLElement>('.md-link');
    if (link?.dataset.href && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      window.open(link.dataset.href, '_blank', 'noopener');
      return;
    }
    const el = (e.target as Element).closest?.('.math');
    const isl = el && this.islands.get(el);
    if (isl) {
      e.preventDefault();
      const hit = isl.hitTest(e.clientX, e.clientY);
      if (e.shiftKey && this.active === isl) isl.extendTo(hit);
      else this.activate(isl, hit);
      // Dragging selects; positions come from the same geometry as clicks.
      const move = (m: MouseEvent) => {
        const c = isl.hitTest(m.clientX, m.clientY);
        if (isl.cursor && (pathKey(c.path) !== pathKey(isl.cursor.path) || c.off !== isl.cursor.off)) isl.extendTo(c);
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
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
    if (mod && !e.altKey && (e.key.toLowerCase() === 'b' || e.key.toLowerCase() === 'i')) {
      e.preventDefault();
      return this.toggleWrap(e.key.toLowerCase() === 'b' ? '**' : '*');
    }
    if (mod && e.altKey && e.code === 'KeyF') {
      e.preventDefault();
      return this.insertFootnote();
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
    let pos = this.getPos();
    if (!pos) return null;
    if (sel.focusNode === this.root) {
      this.setPos(pos);
      pos = this.getPos()!;
    }
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

  /** The text selection as offsets in one paragraph (null if it spans paragraphs or equations are active). */
  private selectedRange(): { block: HTMLElement; start: number; end: number } | null {
    const sel = getSelection();
    if (this.active || !sel?.rangeCount) return null;
    const r = sel.getRangeAt(0);
    const block = this.blockOf(r.startContainer);
    if (!block || block !== this.blockOf(r.endContainer) || this.islands.has(block) || !this.root.contains(block)) return null;
    return { block, start: this.unitsBefore(block, r.startContainer, r.startOffset), end: this.unitsBefore(block, r.endContainer, r.endOffset) };
  }

  /** Edit a paragraph's text (equations stay where their ISLAND chars are) and select `sel` after. */
  private editSource(block: HTMLElement, fn: (src: string) => { src: string; sel: [number, number] }) {
    const cur = this.blockSource(block);
    const { src, sel } = fn(cur.src);
    this.normalizeBlock(block, { src, islands: cur.islands });
    this.root.focus({ preventScroll: true });
    this.setRange(block, sel[0], sel[1]);
    this.record('struct');
  }

  /** ⌘B / ⌘I: wrap the selection in ** or *, or unwrap it if it already is. */
  private toggleWrap(m: string) {
    const r = this.selectedRange();
    if (!r) return;
    const { start: a, end: b } = r;
    const L = m.length;
    this.editSource(r.block, (src) => {
      const before = src.slice(a - L, a) === m && (m !== '*' || src[a - L - 1] !== '*' || src.slice(a - 3, a) === '***');
      const after = src.slice(b, b + L) === m && (m !== '*' || src[b + L] !== '*' || src.slice(b, b + 3) === '***');
      if (a !== b && before && after) return { src: src.slice(0, a - L) + src.slice(a, b) + src.slice(b + L), sel: [a - L, b - L] };
      return { src: src.slice(0, a) + m + src.slice(a, b) + m + src.slice(b), sel: [a + L, b + L] };
    });
  }

  /** ⌘⌥F: insert the next footnote reference here and its definition at the end of the document. */
  private insertFootnote() {
    const r = this.selectedRange();
    if (!r) return;
    const used = [...this.markdown().matchAll(/\[\^(\d+)\]/g)].map((m) => +m[1]);
    const label = String(Math.max(0, ...used) + 1);
    const ref = `[^${label}]`;
    const cur = this.blockSource(r.block);
    this.normalizeBlock(r.block, { src: cur.src.slice(0, r.end) + ref + cur.src.slice(r.end), islands: cur.islands });
    const def = this.newBlock();
    this.root.append(def);
    this.normalizeBlock(def, { src: `${ref}: `, islands: [] });
    this.root.focus({ preventScroll: true });
    this.setPos({ b: this.root.children.length - 1, off: Infinity });
    this.record('struct');
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
    // Part of an equation copied here: paste it as an equation.
    const tex = e.clipboardData?.getData(TEX_MIME);
    if (tex) return void this.insertIsland(tex, false);
    let text = e.clipboardData?.getData('text/plain');
    if (!text) return;
    // A URL pasted over selected text makes a link.
    const url = text.trim();
    const range = this.selectedRange();
    if (/^(https?:\/\/|mailto:)\S+$/.test(url) && range && range.start !== range.end) {
      return this.editSource(range.block, (src) => {
        const label = src.slice(range.start, range.end);
        return { src: src.slice(0, range.start) + `[${label}](${url})` + src.slice(range.end), sel: [range.start + 1, range.start + 1 + label.length] };
      });
    }
    // LaTeX-style delimiters from elsewhere: \[…\] is display math, \(…\) inline.
    text = text.replace(/\\\[([\s\S]*?)\\\]/g, (_, m) => `\n\n$$${m}$$\n\n`).replace(/\\\(([\s\S]*?)\\\)/g, (_, m) => `$${m.trim()}$`);
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
