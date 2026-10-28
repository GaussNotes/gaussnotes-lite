// Equation model: a row is a list of nodes; structured nodes (fractions,
// scripts, brackets...) own one or more slot rows. A cursor is a path of
// (node index, slot index) steps from the root row plus an offset in that row.

export type Sym = { k: 'sym'; tex: string };
export type Raw = { k: 'raw'; tex: string };
export type Cmd = {
  k: 'cmd';
  /** 'sup' | 'sub' | 'delim' | 'matrix' | 'text' | 'root' | any \name taking slots as {args} */
  name: string;
  slots: Row[];
  open?: string; // delim
  close?: string; // delim
  env?: string; // matrix
  cols?: number; // matrix
};
export type MNode = Sym | Raw | Cmd;
export type Row = MNode[];
export type Step = [node: number, slot: number];
export interface Cursor {
  path: Step[];
  off: number;
}

export const sym = (tex: string): Sym => ({ k: 'sym', tex });
export const cmd = (name: string, slots = 1, extra: Partial<Cmd> = {}): Cmd => ({
  k: 'cmd',
  name,
  slots: Array.from({ length: slots }, () => []),
  ...extra,
});

export function clone<T extends MNode | Row>(n: T): T {
  return structuredClone(n);
}

export function rowAt(root: Row, path: Step[]): Row {
  let row = root;
  for (const [n, s] of path) row = (row[n] as Cmd).slots[s];
  return row;
}

/** The structured node owning the row at `path` (null for the root row). */
export function ownerOf(root: Row, path: Step[]): Cmd | null {
  if (!path.length) return null;
  return rowAt(root, path.slice(0, -1))[path[path.length - 1][0]] as Cmd;
}

export const isTextRow = (root: Row, path: Step[]) => ownerOf(root, path)?.name === 'text';

export const pathKey = (path: Step[]) => path.map(([n, s]) => `${n}.${s}`).join('/');

export const sameCursor = (a: Cursor, b: Cursor) => a.off === b.off && pathKey(a.path) === pathKey(b.path);

export const isScript = (n: MNode | undefined) => n?.k === 'cmd' && (n.name === 'sup' || n.name === 'sub');

export const isEmptyCmd = (n: MNode) => n.k === 'cmd' && n.slots.every((s) => s.length === 0);

// Atom classes, so instrumented rendering keeps TeX spacing.
const BIN = new Set('+ - * \\pm \\mp \\times \\cdot \\div \\cup \\cap \\wedge \\vee \\oplus \\otimes \\odot \\circ \\ast \\star \\setminus \\uplus \\sqcup \\bullet'.split(' '));
const REL = new Set(
  '= < > : \\leq \\geq \\neq \\approx \\equiv \\sim \\simeq \\cong \\propto \\in \\notin \\ni \\subset \\subseteq \\supset \\supseteq \\to \\rightarrow \\leftarrow \\Rightarrow \\Leftarrow \\Leftrightarrow \\leftrightarrow \\iff \\implies \\impliedby \\mapsto \\ll \\gg \\perp \\parallel \\mid \\le \\ge \\ne \\gets \\longrightarrow \\longmapsto \\vdash \\models \\prec \\succ \\preceq \\succeq'.split(' '),
);
const OP_LIMITS = new Set('\\sum \\prod \\coprod \\bigcup \\bigcap \\bigoplus \\bigotimes \\lim \\limsup \\liminf \\max \\min \\sup \\inf \\det \\Pr \\gcd \\argmax \\argmin'.split(' '));
const OP = new Set('\\int \\iint \\iiint \\oint \\sin \\cos \\tan \\sec \\csc \\cot \\arcsin \\arccos \\arctan \\sinh \\cosh \\tanh \\log \\ln \\exp \\dim \\ker \\deg \\arg \\hom'.split(' '));
const OPEN = new Set(['(', '[', '\\{', '\\langle', '\\lfloor', '\\lceil']);
const CLOSE = new Set([')', ']', '\\}', '\\rangle', '\\rfloor', '\\rceil', '!']);
const PUNCT = new Set([',', ';']);

export type AtomClass = 'ord' | 'bin' | 'rel' | 'op' | 'oplim' | 'open' | 'close' | 'punct';
export function atomClass(tex: string): AtomClass {
  if (BIN.has(tex)) return 'bin';
  if (REL.has(tex)) return 'rel';
  if (OP_LIMITS.has(tex)) return 'oplim';
  if (OP.has(tex) || tex.startsWith('\\operatorname')) return 'op';
  if (OPEN.has(tex)) return 'open';
  if (CLOSE.has(tex)) return 'close';
  if (PUNCT.has(tex)) return 'punct';
  return 'ord';
}

export const isLetter = (n: MNode | undefined) => n?.k === 'sym' && /^[a-zA-Z]$/.test(n.tex);

/** Nodes that a '/' typed after them should pull into the numerator. */
export function isOperand(n: MNode): boolean {
  if (n.k !== 'sym') return true;
  if (n.tex === '.' || n.tex === "'") return true;
  const c = atomClass(n.tex);
  return c === 'ord' && n.tex !== '\\backslash' && n.tex !== '\\' && n.tex !== '|';
}
