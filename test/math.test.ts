import { describe, expect, it } from 'vitest';
import { parseTex, toTex } from '../src/math/latex';
import { backspace, moveLeft, moveRight, settings, space, typeChar } from '../src/math/editing';
import type { Cursor, Row } from '../src/math/model';

const type = (s: string, root: Row = [], c: Cursor = { path: [], off: 0 }) => {
  for (const ch of s) c = ch === ' ' ? space(root, c) : typeChar(root, c, ch);
  return { root, c, tex: toTex(root) };
};

describe('latex round-trip', () => {
  const cases = [
    'x^{2}+y^{2}=z^{2}',
    '\\frac{a+b}{2}',
    '\\sqrt[3]{x}',
    '\\left( a+b \\right)',
    '\\int_{0}^{\\infty} e^{-x}\\,dx',
    '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}',
    '\\text{if } x \\in \\mathbb{R}',
    '\\textcolor{red}{x}+1',
    '\\begin{array}{cc} 1 & 2 \\end{array}',
    '\\hat{x}\\cdot\\vec{v}',
  ];
  for (const tex of cases)
    it(tex, () => {
      const once = toTex(parseTex(tex));
      expect(toTex(parseTex(once))).toBe(once);
    });
  it('keeps structure', () => {
    expect(toTex(parseTex('x^2'))).toBe('x^{2}');
    expect(toTex(parseTex('\\frac12'))).toBe('\\frac{1}{2}');
    expect(parseTex('\\foo{'))  .toEqual([{ k: 'raw', tex: '\\foo{' }]);
  });
});

describe('typing', () => {
  it('scripts and fractions', () => {
    expect(type('x^2 +1').tex).toBe('x^{2}+1');
    expect(type('a+b/2').tex).toBe('a+\\frac{b}{2}');
    expect(type('(a+b)/2').tex).toBe('\\frac{\\left( a+b \\right)}{2}');
  });
  it('keywords on space (instant mode off)', () => {
    settings.instantKeywords = false;
    expect(type('alpha^2').tex).toBe('\\alpha^{2}');
    expect(type('2pi r').tex).toBe('2\\pi r');
    expect(type('x<=y').tex).toBe('x\\leq y');
    expect(type('sum_i=0 ^n').tex).toBe('\\sum_{i=0}^{n}');
    expect(type('\\foo ').tex).toBe('\\foo');
    expect(type('sqrt x').tex).toBe('\\sqrt{x}');
    expect(type('RR').tex).toBe('RR');
    expect(type('RR ').tex).toBe('\\mathbb{R}');
    expect(type('pmat2 ').tex).toBe('\\begin{pmatrix}  &  \\\\  &  \\end{pmatrix}');
    settings.instantKeywords = true;
  });
  it('instant keywords', () => {
    expect(type('alpha').tex).toBe('\\alpha');
    expect(type('beta+theta+vartheta').tex).toBe('\\beta+\\theta+\\vartheta');
    expect(type('sqrtx').tex).toBe('\\sqrt{x}');
    expect(type('RR').tex).toBe('\\mathbb{R}');
    // Words that could still grow wait for the next character.
    expect(type('delta').tex).toBe('\\delta');
    expect(type('sinh').tex).toBe('\\sinh');
    expect(type('sin(x)').tex).toBe('\\sin\\left( x \\right)');
    expect(type('axxb').tex).toBe('a\\times b');
    expect(type('sinx').tex).toBe('\\sin x');
    expect(type('limx->0').tex).toBe('\\lim_{x\\to0}');
    expect(type('pmat2x2').tex).toBe('pmat2x2'); // matrices still finish with space
    expect(type('a pm b').tex).toBe('a\\pm b');
  });
  it('GaussNotes shortcuts', () => {
    expect(type('xsr+ycb').tex).toBe('x^{2}+y^{3}');
    expect(type('etd2').tex).toBe('e^{2}');
    expect(type('ett2').tex).toBe('e^{2}');
    expect(type('ddxf').tex).toBe('\\frac{df}{d}');
    expect(type('ddelf').tex).toBe('\\frac{\\partial f}{\\partial}');
    expect(type('pii+xii+psii').tex).toBe('\\pi+\\xi+\\psi');
    expect(type('pir').tex).toBe('\\pi r');
    expect(type('Asub=B').tex).toBe('A\\subseteq B');
    expect(type('Au++B').tex).toBe('A\\uplus B');
    expect(type('anot=b').tex).toBe('a\\neq b');
    expect(type('a<=>b').tex).toBe('a\\iff b');
    expect(type('||v').tex).toBe('\\left\\| v \\right\\|');
    expect(type('trA').tex).toBe('\\operatorname{tr}A');
    expect(type('AAxEEy').tex).toBe('\\forall x\\exists y');
    expect(type('NN+ZZ+QQ').tex).toBe('\\mathbb{N}+\\mathbb{Z}+\\mathbb{Q}');
    expect(type('vecv').tex).toBe('\\overrightarrow{v}');
    expect(type('redx').tex).toBe('\\textcolor{red}{x}');
    expect(type('tend').tex).toBe('\\xrightarrow[]{}');
    expect(type('logx').tex).toBe('\\log_{x}');
    expect(type('vartheta+rt').tex).toBe('\\vartheta+\\sqrt[]{}');
    expect(type('sinhx').tex).toBe('\\sinh x');
    expect(type('cdots').tex).toBe('\\cdots');
  });
  it('a fraction after lim leaves the limit alone', () => {
    const r = type('limx->0');
    const out = moveRight(r.root, r.c)!; // step out of the subscript
    let c = out;
    for (const ch of '1/') c = typeChar(r.root, c, ch);
    expect(toTex(r.root)).toBe('\\lim_{x\\to0}\\frac{1}{}');
    c = typeChar(r.root, { path: [], off: 2 }, '/'); // '/' straight after the limit
    expect(toTex(r.root)).toBe('\\lim_{x\\to0}\\frac{}{}\\frac{1}{}');
    // ...while a term with an exponent goes into the numerator whole.
    expect(type('x^2 /').tex).toBe('\\frac{x^{2}}{}');
  });
  it('big operators come with limit slots', () => {
    const r = type('sum');
    expect(r.c).toEqual({ path: [[1, 0]], off: 0 }); // in the subscript
    expect(type('sumi=1 n').tex).toBe('\\sum_{i=1}^{n}');
    expect(type('sum_i=1^n').tex).toBe('\\sum_{i=1}^{n}');
    expect(type('int').tex).toBe('\\int'); // empty slots are not saved
    // From the end of the superscript, → lands after the whole operator.
    const s = type('sumi n');
    expect(moveRight(s.root, s.c)).toEqual({ path: [], off: 3 });
  });
  it('→ from the end of any slot lands just after the object, a second → leaves', () => {
    for (const keys of ['x^2', 'x_k', '1/2', 'sqrtx', '(a+b', 'hatx', 'pmat1 a', 'sumi n', 'limx->0']) {
      const { root, c } = type(keys);
      expect(c.path.length, keys).toBeGreaterThan(0);
      let cur = c;
      // walk right until back in the root row, never leaving the equation on the way
      for (let i = 0; cur.path.length && i < 10; i++) cur = moveRight(root, cur)!;
      expect(cur, keys).toEqual({ path: [], off: root.length });
      expect(moveRight(root, cur), keys).toBeNull();
    }
  });
  it('← out of an object lands just before it', () => {
    for (const keys of ['1/2', 'sqrtx', '(a+b']) {
      const { root, c } = type(keys);
      let cur = c;
      for (let i = 0; cur.path.length && i < 10; i++) cur = moveLeft(root, cur)!;
      expect(cur, keys).toEqual({ path: [], off: 0 });
      expect(moveLeft(root, cur), keys).toBeNull();
    }
  });
  it('backspace dissolves structures', () => {
    const { root, c } = type('x/');
    const r = backspace(root, c);
    expect(toTex(root)).toBe('x');
    expect(r).toEqual({ path: [], off: 1 });
  });
  it('navigates in and out', () => {
    const root = parseTex('\\frac{a}{b}c');
    let c: Cursor | null = { path: [], off: 0 };
    const seen: string[] = [];
    while (c) { seen.push(JSON.stringify(c)); c = moveRight(root, c); }
    expect(seen.length).toBe(7);
    c = { path: [], off: 2 };
    let n = 0;
    while (c) { n++; c = moveLeft(root, c); }
    expect(n).toBe(7);
  });
});
