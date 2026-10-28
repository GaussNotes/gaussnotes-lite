import { describe, expect, it } from 'vitest';
import { parseMarkdown, serializeMarkdown } from '../src/doc/markdown';

describe('markdown', () => {
  it('parses inline, display and escaped dollars', () => {
    const md = '# Title\n\nPrice \\$5 and $x^2$ here.\n\n$$\n\\int f\n$$\n\nend\n';
    const blocks = parseMarkdown(md);
    expect(blocks).toEqual([
      { t: 'p', parts: ['# Title'] },
      { t: 'p', parts: ['Price $5 and ', { tex: 'x^2' }, ' here.'] },
      { t: 'math', tex: '\\int f' },
      { t: 'p', parts: ['end'] },
    ]);
    expect(serializeMarkdown(blocks)).toBe(md);
  });
  it('keeps soft line breaks and lone dollars', () => {
    const md = 'line one\nline two costs $3\n';
    expect(serializeMarkdown(parseMarkdown(md))).toBe('line one\nline two costs \\$3\n');
  });
  it('handles $$ inline with text', () => {
    expect(parseMarkdown('a $$b$$ c').map((b) => b.t)).toEqual(['p', 'math', 'p']);
  });
});
