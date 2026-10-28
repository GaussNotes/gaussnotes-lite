import { describe, expect, it } from 'vitest';
import { ISLAND, parseBlock, parseInlineMd, type Tok } from '../src/doc/inline';

// Compact form: **x** → <strong>x</strong> etc., for readable expectations.
const show = (toks: Tok[]): string =>
  toks
    .map((t) => {
      switch (t.t) {
        case 'text': return t.s;
        case 'island': return '§';
        case 'mark': return `{${t.s}}`;
        case 'wrap': return `<${t.tag}>${show(t.kids)}</${t.tag}>`;
        case 'link': return `<a ${t.href}>${show(t.kids)}</a>`;
        case 'fnref': return `<fn ${t.label}>`;
        case 'fninline': return `<note>${show(t.kids)}</note>`;
      }
    })
    .join('');
const md = (s: string) => show(parseInlineMd(s));

describe('inline markdown', () => {
  it('emphasis', () => {
    expect(md('a **b** c')).toBe('a <strong>b</strong> c');
    expect(md('a *b* c')).toBe('a <em>b</em> c');
    expect(md('__b__ and _i_')).toBe('<strong>b</strong> and <em>i</em>');
    expect(md('***bi***')).toBe('<strong><em>bi</em></strong>');
    expect(md('*a **b** c*')).toBe('<em>a <strong>b</strong> c</em>');
    expect(md('~~gone~~')).toBe('<s>gone</s>');
  });
  it('leaves non-emphasis alone', () => {
    expect(md('2 * 3 * 4')).toBe('2 * 3 * 4');
    expect(md('snake_case_name')).toBe('snake_case_name');
    expect(md('**unclosed')).toBe('**unclosed');
    expect(md('\\*literal\\*')).toBe('\\*literal\\*');
  });
  it('links', () => {
    expect(md('see [the *docs*](https://x.org/a) now')).toBe('see <a https://x.org/a>the <em>docs</em></a> now');
    expect(md('[not a link] (x)')).toBe('[not a link] (x)');
  });
  it('footnotes', () => {
    expect(md('Claim[^1] and[^note].')).toBe('Claim<fn 1> and<fn note>.');
    expect(md('Inline^[a *quick* note] here')).toBe('Inline<note>a <em>quick</em> note</note> here');
    const def = parseBlock('[^1]: The source.');
    expect(def.fnDef).toBe('1');
    expect(show(def.toks)).toBe('{[^1]: }The source.');
  });
  it('equations inside formatting', () => {
    expect(md(`**area ${ISLAND} here**`)).toBe('<strong>area § here</strong>');
  });
  it('headings and quotes mark their prefix', () => {
    expect(parseBlock('## Title *x*').heading).toBe(2);
    expect(show(parseBlock('## Title *x*').toks)).toBe('{## }Title <em>x</em>');
    expect(parseBlock('> quoted').quote).toBe(true);
    expect(parseBlock('#### Four').heading).toBe(4);
    expect(parseBlock('##### Five').heading).toBe(5);
    expect(parseBlock('###### Six').heading).toBe(6);
    expect(parseBlock('####### Seven').heading).toBeUndefined();
    expect(parseBlock('#hashtag').heading).toBeUndefined();
    const t = parseBlock('# Title {-}');
    expect(t.unnumbered).toBe(true);
    expect(show(t.toks)).toBe('{# }Title{ {-}}');
    expect(parseBlock('## Refs {.unnumbered}').unnumbered).toBe(true);
  });
});
