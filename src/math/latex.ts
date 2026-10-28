import { atomClass, type Cmd, type Cursor, type MNode, pathKey, type Row, type Step, sym } from './model';

// ---------------------------------------------------------------------------
// Serialization. `toTex` produces clean LaTeX for storage and the AI.
// `toInstrumentedTex` wraps every node in \htmlData so the rendered DOM can be
// mapped back to model positions (clicks, caret placement).
// ---------------------------------------------------------------------------

export const TWO_ARG = new Set(['frac', 'dfrac', 'tfrac', 'binom', 'overset', 'underset', 'stackrel']);
export const ONE_ARG = new Set([
  'sqrt', 'hat', 'bar', 'vec', 'dot', 'ddot', 'tilde', 'widehat', 'widetilde', 'overline', 'underline',
  'overbrace', 'underbrace', 'overrightarrow', 'mathbf', 'mathbb', 'mathcal', 'mathrm', 'mathit', 'mathfrak',
  'mathsf', 'mathscr', 'boldsymbol', 'bm', 'operatorname', 'boxed', 'cancel', 'pmb',
]);
const TEXT_CMDS = new Set(['text', 'textrm', 'textbf', 'textit', 'mbox', 'textsf', 'texttt']);
export const MATRIX_ENVS = new Set(['matrix', 'pmatrix', 'bmatrix', 'Bmatrix', 'vmatrix', 'Vmatrix', 'smallmatrix', 'cases', 'aligned', 'gathered']);

export interface RenderMap {
  nodes: { path: Step[]; idx: number }[];
  rows: Step[][];
}

interface Ctx {
  map?: RenderMap;
  cursor?: Cursor | null;
  ghost?: Row | null;
  display?: boolean;
}

function cat(a: string, b: string): string {
  if (/\\[a-zA-Z]+$/.test(a) && /^[a-zA-Z]/.test(b)) return a + ' ' + b;
  return a + b;
}

const escText = (c: string) =>
  ({ '\\': '\\textbackslash{}', '{': '\\{', '}': '\\}', $: '\\$', '%': '\\%', '&': '\\&', '#': '\\#', _: '\\_', '^': '\\textasciicircum{}', '~': '\\textasciitilde{}' })[c] ?? c;

function emitRow(row: Row, path: Step[], ctx: Ctx, textMode = false): string {
  const { map } = ctx;
  const atCursor = ctx.cursor && ctx.ghost?.length && pathKey(ctx.cursor.path) === pathKey(path) ? ctx.cursor.off : -1;
  const ghost = () => `\\htmlClass{gn-ghost}{${emitRow(ctx.ghost!, [], {}, textMode) || '{}'}}`;

  if (!row.length) {
    if (!map) return '';
    const id = map.rows.push(path) - 1;
    const ph = `\\htmlData{e=${id}}{\\htmlClass{gn-ph}{${textMode ? '\\square' : '\\square'}}}`;
    return atCursor === 0 ? ghost() + ph : ph;
  }
  let out = '';
  let scripts = new Set<string>();
  let hasBase = false;
  row.forEach((node, i) => {
    if (i === atCursor) {
      out = cat(out, ghost());
      hasBase = true;
      scripts = new Set();
    }
    const id = map ? map.nodes.push({ path, idx: i }) - 1 : -1;
    const wrap = (s: string) => (map ? `\\htmlData{n=${id}}{${s}}` : s);
    if (textMode && node.k === 'sym') {
      out += wrap(escText(node.tex));
      return;
    }
    if (node.k === 'cmd' && (node.name === 'sup' || node.name === 'sub')) {
      if (!hasBase || scripts.has(node.name)) {
        out += '{}';
        scripts = new Set();
      }
      out += (node.name === 'sup' ? '^{' : '_{') + wrap(emitRow(node.slots[0], [...path, [i, 0]], ctx)) + '}';
      scripts.add(node.name);
      hasBase = true;
      return;
    }
    out = cat(out, emitNode(node, [...path], i, ctx, wrap));
    hasBase = true;
    scripts = new Set();
  });
  if (atCursor === row.length) out = cat(out, ghost());
  return out;
}

function emitNode(node: MNode, path: Step[], i: number, ctx: Ctx, wrap: (s: string) => string): string {
  if (node.k === 'raw') return wrap(node.tex);
  if (node.k === 'sym') {
    const tex = node.tex === '\\' ? '\\backslash' : node.tex;
    if (!ctx.map) return tex;
    switch (atomClass(tex)) {
      case 'bin': return `\\mathbin{${wrap(tex)}}`;
      case 'rel': return `\\mathrel{${wrap(tex)}}`;
      case 'oplim': return `\\mathop{${wrap(tex)}}${ctx.display ? '\\limits' : ''}`;
      case 'op': return `\\mathop{${wrap(tex)}}\\nolimits`;
      case 'open': return `\\mathopen{${wrap(tex)}}`;
      case 'close': return `\\mathclose{${wrap(tex)}}`;
      case 'punct': return `\\mathpunct{${wrap(tex)}}`;
      default: return wrap(tex);
    }
  }
  const slot = (s: number, textMode = false) => emitRow(node.slots[s], [...path, [i, s]], ctx, textMode);
  switch (node.name) {
    case 'delim':
      return wrap(`\\left${node.open} ${slot(0)} \\right${node.close}`);
    case 'root':
      return wrap(`\\sqrt[${slot(0)}]{${slot(1)}}`);
    case 'text':
      return wrap(`\\text{${slot(0, true)}}`);
    case 'matrix': {
      const cols = node.cols ?? 1;
      const rows: string[] = [];
      for (let r = 0; r * cols < node.slots.length; r++)
        rows.push(Array.from({ length: cols }, (_, c) => slot(r * cols + c)).join(' & '));
      return wrap(`\\begin{${node.env}} ${rows.join(' \\\\ ')} \\end{${node.env}}`);
    }
    default:
      return wrap(`\\${node.name}` + node.slots.map((_, s) => `{${slot(s)}}`).join(''));
  }
}

export const toTex = (row: Row) => emitRow(row, [], {}).trim();

export function toInstrumentedTex(row: Row, cursor: Cursor | null, ghost: Row | null, display = false): { tex: string; map: RenderMap } {
  const map: RenderMap = { nodes: [], rows: [] };
  return { tex: emitRow(row, [], { map, cursor, ghost, display }), map };
}

// ---------------------------------------------------------------------------
// Parsing. Handles the structures above; anything else becomes a raw node that
// round-trips verbatim, so arbitrary LaTeX still loads and renders.
// ---------------------------------------------------------------------------

class Parser {
  i = 0;
  constructor(readonly s: string) {}

  ws() {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++;
  }
  peekCmd(): string | null {
    const m = /^\\([a-zA-Z]+|.)/.exec(this.s.slice(this.i));
    return m ? m[1] : null;
  }
  readCmd(): string {
    const name = this.peekCmd()!;
    this.i += name.length + 1;
    if (/^[a-zA-Z]/.test(name)) this.ws();
    return name;
  }
  /** Raw source of a balanced {...} group starting at the current position, braces excluded. */
  rawGroup(): string {
    this.ws();
    if (this.s[this.i] !== '{') throw new Error('expected {');
    let depth = 0;
    const start = this.i;
    for (; this.i < this.s.length; this.i++) {
      const c = this.s[this.i];
      if (c === '\\') this.i++;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) return this.s.slice(start + 1, this.i++);
    }
    throw new Error('unbalanced');
  }
  readDelim(): string {
    this.ws();
    if (this.s[this.i] === '\\') return '\\' + this.readCmd();
    return this.s[this.i++];
  }

  row(stop: (p: Parser) => boolean): Row {
    const out: Row = [];
    for (;;) {
      this.ws();
      if (this.i >= this.s.length || stop(this)) return out;
      const c = this.s[this.i];
      if (c === '}') throw new Error('unexpected }');
      if (c === '{') {
        this.i++;
        out.push(...this.row((p) => p.s[p.i] === '}'));
        this.expect('}');
      } else if (c === '^' || c === '_') {
        this.i++;
        out.push({ k: 'cmd', name: c === '^' ? 'sup' : 'sub', slots: [this.arg()] });
      } else if (c === '\\') {
        out.push(...this.command());
      } else {
        this.i++;
        out.push(sym(c));
      }
    }
  }

  expect(c: string) {
    this.ws();
    if (this.s[this.i] !== c) throw new Error(`expected ${c}`);
    this.i++;
  }

  arg(): Row {
    this.ws();
    const c = this.s[this.i];
    if (c === '{') {
      this.i++;
      const r = this.row((p) => p.s[p.i] === '}');
      this.expect('}');
      return r;
    }
    if (c === '\\') return this.command();
    if (c === undefined) throw new Error('missing argument');
    this.i++;
    return [sym(c)];
  }

  command(): MNode[] {
    const start = this.i;
    const name = this.readCmd();
    if (name === 'left') {
      const open = this.readDelim();
      const inner = this.row((p) => p.peekCmd() === 'right');
      if (this.peekCmd() !== 'right') throw new Error('missing \\right');
      this.readCmd();
      return [{ k: 'cmd', name: 'delim', open, close: this.readDelim(), slots: [inner] }];
    }
    if (name === 'begin') {
      const env = this.rawGroup();
      if (MATRIX_ENVS.has(env)) return [this.matrix(env)];
      const end = this.s.indexOf(`\\end{${env}}`, this.i);
      if (end < 0) throw new Error('unterminated env');
      this.i = end + `\\end{${env}}`.length;
      return [{ k: 'raw', tex: this.s.slice(start, this.i) }];
    }
    if (TEXT_CMDS.has(name)) {
      const body = this.rawGroup()
        .replace(/\\textbackslash(\{\})?/g, '\\')
        .replace(/\\textasciicircum(\{\})?/g, '^')
        .replace(/\\textasciitilde(\{\})?/g, '~')
        .replace(/\\([{}$%&#_])/g, '$1');
      return [{ k: 'cmd', name: 'text', slots: [[...body].map(sym)] }];
    }
    if (name === 'sqrt') {
      this.ws();
      if (this.s[this.i] === '[') {
        this.i++;
        const index = this.row((p) => p.s[p.i] === ']');
        this.expect(']');
        return [{ k: 'cmd', name: 'root', slots: [index, this.arg()] }];
      }
    }
    if (TWO_ARG.has(name)) return [{ k: 'cmd', name, slots: [this.arg(), this.arg()] }];
    if (ONE_ARG.has(name)) {
      const a = this.arg();
      if (/^math(bb|cal|frak|scr)$/.test(name) && a.length === 1 && a[0].k === 'sym' && /^[A-Za-z]$/.test(a[0].tex))
        return [sym(`\\${name}{${a[0].tex}}`)];
      return [{ k: 'cmd', name, slots: [a] }];
    }
    if (name === 'right' || name === 'end') throw new Error(`unexpected \\${name}`);
    // Unknown command with arguments: keep verbatim.
    const save = this.i;
    this.ws();
    if (this.s[this.i] === '{' && /^[a-zA-Z]/.test(name)) {
      while (this.s[this.i] === '{') {
        this.rawGroup();
        const j = this.i;
        this.ws();
        if (this.s[this.i] !== '{') this.i = j;
      }
      return [{ k: 'raw', tex: this.s.slice(start, this.i) }];
    }
    this.i = save;
    return [sym('\\' + name)];
  }

  matrix(env: string): Cmd {
    const grid: Row[][] = [[]];
    for (;;) {
      const cell = this.row((p) => p.s[p.i] === '&' || p.peekCmd() === '\\' || p.peekCmd() === 'end');
      grid[grid.length - 1].push(cell);
      if (this.s[this.i] === '&') this.i++;
      else if (this.peekCmd() === '\\') {
        this.i += 2;
        grid.push([]);
      } else if (this.peekCmd() === 'end') {
        this.readCmd();
        this.rawGroup();
        break;
      } else throw new Error('unterminated matrix');
    }
    if (grid.length > 1 && grid[grid.length - 1].length === 1 && grid[grid.length - 1][0].length === 0) grid.pop();
    const cols = Math.max(...grid.map((r) => r.length));
    const slots = grid.flatMap((r) => [...r, ...Array.from({ length: cols - r.length }, () => [] as Row)]);
    return { k: 'cmd', name: 'matrix', env, cols, slots };
  }
}

export function parseTex(src: string): Row {
  const s = src.trim();
  if (!s) return [];
  try {
    const p = new Parser(s);
    const row = p.row(() => false);
    return row;
  } catch {
    return [{ k: 'raw', tex: s }];
  }
}
