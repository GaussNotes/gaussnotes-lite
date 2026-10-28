import { describe, expect, it } from 'vitest';
import { parseTex, toTex } from '../src/math/latex';
import { backspace, moveLeft, moveRight, space, typeChar } from '../src/math/editing';
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
  it('keywords', () => {
    expect(type('alpha^2').tex).toBe('\\alpha^{2}');
    expect(type('2pi r').tex).toBe('2\\pi r');
    expect(type('x<=y').tex).toBe('x\\leq y');
    expect(type('sum_i=0 ^n').tex).toBe('\\sum_{i=0}^{n}');
    expect(type('\\foo ').tex).toBe('\\foo');
    expect(type('sqrt x').tex).toBe('\\sqrt{x}');
    expect(type('RR').tex).toBe('RR');
    expect(type('RR ').tex).toBe('\\mathbb{R}');
    expect(type('pmat2 ').tex).toBe('\\begin{pmatrix}  &  \\\\  &  \\end{pmatrix}');
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
