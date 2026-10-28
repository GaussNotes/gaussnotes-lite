// The document is stored as plain markdown: paragraphs separated by blank
// lines, inline math as $...$, display math as $$...$$. Text is kept verbatim
// (headings, lists, emphasis are just characters), so files round-trip.

export type Part = string | { tex: string };
export type Block = { t: 'p'; parts: Part[] } | { t: 'math'; tex: string };

export function parseInline(text: string): Part[] {
  const parts: Part[] = [];
  let buf = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\' && text[i + 1] === '$') {
      buf += '$';
      i++;
    } else if (c === '$') {
      let j = i + 1;
      while (j < text.length && !(text[j] === '$' && text[j - 1] !== '\\')) j++;
      if (j >= text.length) {
        buf += c;
        continue;
      }
      if (buf) parts.push(buf);
      buf = '';
      parts.push({ tex: text.slice(i + 1, j) });
      i = j;
    } else buf += c;
  }
  if (buf) parts.push(buf);
  return parts;
}

export function parseMarkdown(md: string): Block[] {
  const blocks: Block[] = [];
  const src = md.replace(/\r\n?/g, '\n');
  const re = /(^|[^\\])\$\$([\s\S]*?)\$\$/g;
  let last = 0;
  const text = (s: string) => {
    for (const para of s.split(/\n[ \t]*\n/)) {
      const t = para.replace(/^\n+|\n+$/g, '');
      if (t.trim()) blocks.push({ t: 'p', parts: parseInline(t) });
    }
  };
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const start = m.index + m[1].length;
    text(src.slice(last, start));
    blocks.push({ t: 'math', tex: m[2].trim() });
    last = re.lastIndex;
  }
  text(src.slice(last));
  return blocks;
}

export function serializeInline(parts: Part[]): string {
  return parts.map((p) => (typeof p === 'string' ? p.replace(/\$/g, '\\$') : p.tex.trim() ? `$${p.tex.trim()}$` : '')).join('');
}

export function serializeMarkdown(blocks: Block[]): string {
  const out = blocks
    .map((b) => (b.t === 'math' ? (b.tex.trim() ? `$$\n${b.tex.trim()}\n$$` : '') : serializeInline(b.parts)))
    .filter((s) => s.trim());
  return out.length ? out.join('\n\n') + '\n' : '';
}
