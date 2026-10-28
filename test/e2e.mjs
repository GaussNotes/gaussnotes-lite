// Drives the editor in headless Chromium. Usage: node test/e2e.mjs [url] [shotDir]
import { chromium } from 'playwright';
const url = process.argv[2] ?? 'http://localhost:5199';
const shots = process.argv[3] ?? '.';
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const context = await browser.newContext({ viewport: { width: 1400, height: 800 }, permissions: ['clipboard-read', 'clipboard-write'] });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !/503|Failed to load/.test(m.text()) && errors.push(m.text()));
await page.goto(url);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForSelector('.math');
await page.screenshot({ path: `${shots}/1-welcome.png` });

const md = () => page.evaluate(() => window.gn.markdown());
const check = (name, got, want) => {
  const ok = got.includes(want);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `\n   want: ${JSON.stringify(want)}\n   got:  ${JSON.stringify(got)}`}`);
};

// New doc, type text then inline math.
page.on('dialog', (d) => d.accept());
await page.click('#new');
await page.click('#doc');
await page.keyboard.type('Energy: ');
await page.keyboard.type('$E=mc^2');
await page.keyboard.press('Escape');
await page.keyboard.type(' done.');
check('inline math', await md(), 'Energy: $E=mc^{2}$ done.');

// Display math with fraction, sum, keyword.
await page.keyboard.press('Enter');
await page.keyboard.type('$$');
await page.keyboard.type('sum_i=1 ^n i = n(n+1)/2');
await page.screenshot({ path: `${shots}/2-display-typing.png` });
await page.keyboard.press('Enter');
check('display math', await md(), '$$\n\\sum_{i=1}^{n}i=\\frac{n\\left( n+1 \\right)}{2}\n$$');

await page.keyboard.type('Then ');
await page.keyboard.type('$alpha/beta');
await page.keyboard.press('ArrowRight');
await page.keyboard.press('ArrowRight');
await page.keyboard.type(' text');
check('fraction exit by arrows', await md(), 'Then $\\frac{\\alpha}{\\beta}$ text');

// Undo / redo
await page.keyboard.press('Meta+z');
const afterUndo = await md();
check('undo removes text', afterUndo.includes(' text') ? 'still there' : 'gone', 'gone');
await page.keyboard.press('Meta+Shift+z');
check('redo', await md(), 'Then $\\frac{\\alpha}{\\beta}$ text');

// Click inside the display equation, on the "n+1" part, and type.
const disp = page.locator('div.math.display').first();
const target = disp.locator('[data-n]').filter({ hasText: /^1$/ }).last();
const box = await target.boundingBox();
await page.mouse.click(box.x + box.width - 1, box.y + box.height / 2);
await page.keyboard.type('+k');
check('click maps into equation', await md(), 'n+1+k');
await page.screenshot({ path: `${shots}/3-click-edit.png` });

// Up/down in fraction: go to numerator, then down to denominator.
await page.keyboard.press('ArrowDown');
await page.keyboard.type('x');
check('down moves into denominator', await md(), '{2x}');
await page.keyboard.press('Escape');

// Reload from markdown round-trip.
const before = await md();
await page.evaluate((m) => window.gn.load(m), before);
check('markdown round-trip', await md(), before);

// Ghost completion with a mocked model.
let lastReq = null;
await page.route('**/api/complete', async (route) => {
  lastReq = JSON.parse(route.request().postData());
  await route.fulfill({ json: { text: '\\int_{0}^{1} x\\,dx' } });
});
await page.route('**/api/generate', async (route) => {
  await route.fulfill({ json: { text: '$$\\nabla\\cdot\\mathbf{E}=\\frac{\\rho}{\\varepsilon_{0}}$$' } });
});
await page.evaluate(() => window.gn.load('Area: '));
await page.click('#doc');
await page.keyboard.press('End');
await page.keyboard.type('$A=');
await page.waitForSelector('.gn-ghost', { timeout: 3000 });
await page.screenshot({ path: `${shots}/4-ghost.png` });
check('completion request has cursor context', JSON.stringify(lastReq), '"before":"A="');
await page.keyboard.press('Tab');
check('tab accepts ghost', await md(), '$A=\\int_{0}^{1}x\\,dx$');
await page.keyboard.press('Escape');

// Typing the ghost's first char keeps the rest.
await page.keyboard.type(' and $B=');
await page.waitForSelector('.gn-ghost');
await page.keyboard.type('\\');
const ghostAfter = await page.locator('.gn-ghost').count();
check('typing over ghost (non-matching) clears it', String(ghostAfter), '0');
await page.keyboard.press('Backspace');
await page.keyboard.press('Escape');

// Cmd+K in text creates an equation from a description.
await page.keyboard.press('End');
await page.keyboard.press('Enter');
await page.keyboard.press('Meta+k');
await page.waitForSelector('#prompt:not([hidden])');
await page.keyboard.type("Gauss's law");
await page.keyboard.press('Enter');
await page.waitForFunction(() => window.gn.markdown().includes('nabla'));
check('cmd+k inserts display equation', await md(), '$$\n\\nabla\\cdot\\mathbf{E}=\\frac{\\rho}{\\varepsilon_{0}}\n$$');
await page.screenshot({ path: `${shots}/5-cmdk.png` });
await page.keyboard.press('Escape');

// Backspace from text enters the inline equation before it; clicking inline math places cursor.
await page.evaluate(() => window.gn.load('x $a+b$ y'));
const inl = page.locator('span.math [data-n]').filter({ hasText: /^a$/ });
const ib = await inl.boundingBox();
await page.mouse.click(ib.x + ib.width * 0.9, ib.y + ib.height / 2);
await page.keyboard.type('c');
check('click inline math', await md(), 'x $ac+b$ y');
await page.keyboard.press('Escape');
await page.keyboard.press('Backspace');
check('backspace into inline math from text', await md(), 'x $ac+b$ y');
await page.keyboard.press('Backspace');
check('…then deletes inside it', await md(), 'x $ac+$ y');

// $$ on an empty line makes display math.
await page.evaluate(() => window.gn.load('para'));
await page.click('#doc');
await page.keyboard.press('End');
await page.keyboard.press('Enter');
await page.keyboard.type('$$x');
await page.keyboard.press('Enter');
await page.keyboard.type('after');
check('$$ display + enter exits below', await md(), 'para\n\n$$\nx\n$$\n\nafter');

// Sum with prefilled limits: → from the top limit lands right of the ∑, inside the equation.
await page.evaluate(() => window.gn.load(''));
await page.mouse.click(500, 600); // empty area below the only paragraph
await page.keyboard.type('$$sumi=1');
await page.screenshot({ path: `${shots}/7-sum-sub.png` });
await page.keyboard.press('ArrowRight');
await page.keyboard.type('n');
await page.keyboard.press('ArrowRight');
const geo = await page.evaluate(() => {
  const caret = document.querySelector('.math.active .m-caret').getBoundingClientRect();
  const sum = [...document.querySelectorAll('.math.active [data-n]')].find((e) => e.textContent === '∑').getBoundingClientRect();
  return { caretX: caret.left, sumRight: sum.right, caretMid: (caret.top + caret.bottom) / 2, sumTop: sum.top, sumBottom: sum.bottom, active: !!document.querySelector('.math.active') };
});
await page.screenshot({ path: `${shots}/8-sum-after.png` });
check('→ from limit stays in equation', String(geo.active), 'true');
check('caret right of ∑, level with it', String(geo.caretX >= geo.sumRight - 1 && geo.caretMid > geo.sumTop && geo.caretMid < geo.sumBottom), 'true');
await page.keyboard.type('a_k');
await page.keyboard.press('ArrowRight');
await page.keyboard.press('ArrowRight');
check('second → exits; content typed after ∑', await md(), '$$\n\\sum_{i=1}^{n}a_{k}\n$$');

// Same for a plain superscript: → out of x^2 puts the caret right of the whole x², level with x.
await page.evaluate(() => window.gn.load('a'));
await page.mouse.click(500, 600);
await page.keyboard.type('$x^2');
await page.keyboard.press('ArrowRight');
const g2 = await page.evaluate(() => {
  const caret = document.querySelector('.math.active .m-caret').getBoundingClientRect();
  const two = [...document.querySelectorAll('.math.active [data-n]')].find((e) => e.textContent === '2').getBoundingClientRect();
  const x = [...document.querySelectorAll('.math.active [data-n]')].find((e) => e.textContent === 'x').getBoundingClientRect();
  return { ok: caret.left >= two.right - 1 && Math.abs((caret.top + caret.bottom) / 2 - (x.top + x.bottom) / 2) < 3 };
});
check('caret after x² is right of the exponent, at base height', String(g2.ok), 'true');
await page.keyboard.type('+1');
check('typing after x² continues the equation', await md(), 'a$x^{2}+1$');

// lim + Tab (instant symbols off): converts and leaves the cursor in the subscript.
await page.uncheck('#instant-toggle');
await page.evaluate(() => window.gn.load('a'));
await page.mouse.click(500, 600);
await page.keyboard.type('$lim');
await page.keyboard.press('Tab');
await page.keyboard.type('x->0');
check('lim + Tab puts cursor in the subscript', await md(), '$\\lim_{x\\to0}$');
await page.keyboard.press('Escape');
await page.check('#instant-toggle');
await page.mouse.click(500, 600); // back into the document, at its end
await page.keyboard.type(' $lim');
await page.keyboard.type('n');
check('lim converts instantly when instant symbols are on', await md(), '$\\lim_{n}$');
await page.keyboard.press('Escape');

// ---- selection, copy/paste as LaTeX
const clip = () => page.evaluate(() => navigator.clipboard.readText());
const nodeBox = (text) => page.locator('div.math [data-n]').filter({ hasText: new RegExp(`^${text}$`) }).first().boundingBox();
await page.evaluate(() => window.gn.load('$$\nx^{2}+\\frac{a}{b}=c\n$$\n\nsome text'));
let cb = await nodeBox('c');
await page.mouse.click(cb.x + cb.width + 2, cb.y + cb.height / 2); // after c
for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowLeft');
await page.screenshot({ path: `${shots}/11-selection.png` });
const selShown = await page.evaluate(() => getComputedStyle(document.querySelector('.math.active .m-sel')).display);
check('shift+← shows a selection highlight', selShown, 'block');
await page.keyboard.press('Meta+c');
check('⌘C copies the selected part as LaTeX', await clip(), '\\frac{a}{b}=c');
await page.keyboard.type('(');
check('( wraps the selection', await md(), 'x^{2}+\\left( \\frac{a}{b}=c \\right)');
await page.keyboard.press('Meta+z');
check('undo unwraps', await md(), 'x^{2}+\\frac{a}{b}=c');

// Drag across x² and + then delete.
await page.evaluate(() => window.gn.load('$$\nx^{2}+\\frac{a}{b}=c\n$$\n\nsome text'));
const xb = await nodeBox('x');
const pb = await nodeBox('\\+');
await page.mouse.move(xb.x + 1, xb.y + xb.height / 2);
await page.mouse.down();
await page.mouse.move(pb.x + pb.width - 1, pb.y + pb.height / 2, { steps: 5 });
await page.mouse.up();
await page.keyboard.press('Meta+c');
check('mouse drag selects', await clip(), 'x^{2}+');
await page.keyboard.press('Backspace');
check('backspace deletes the selection', await md(), '$$\n\\frac{a}{b}=c\n$$');

// Paste the copied part into text: it becomes an inline equation.
await page.keyboard.press('Escape');
await page.locator('.blk').last().click();
await page.keyboard.press('End');
await page.keyboard.type(' ');
await page.keyboard.press('Meta+v');
check('pasting equation LaTeX into text makes an equation', await md(), 'some text $x^{2}+$');
await page.keyboard.press('Escape');

// Paste plain LaTeX from elsewhere into an equation: parsed (and brackets normalized).
await page.evaluate(() => navigator.clipboard.writeText('\\bigl(a+b\\bigr)^2'));
await page.evaluate(() => window.gn.load('$$\ny=\n$$'));
cb = await nodeBox('=');
await page.mouse.click(cb.x + cb.width + 4, cb.y + cb.height / 2);
await page.keyboard.press('Meta+v');
check('pasted LaTeX becomes structure', await md(), 'y=\\left( a+b \\right)^{2}');
// ⌘A then typing replaces everything.
await page.keyboard.press('Meta+a');
await page.keyboard.type('z');
check('⌘A + type replaces the equation', await md(), '$$\nz\n$$');
await page.keyboard.press('Escape');

// \( \) and \[ \] pasted into text.
await page.evaluate(() => navigator.clipboard.writeText('see \\(e^{x}\\) here'));
await page.evaluate(() => window.gn.load('start'));
await page.locator('.blk').last().click();
await page.keyboard.press('End');
await page.keyboard.press('Meta+v');
check('\\( \\) pasted into text becomes inline math', await md(), 'startsee $e^{x}$ here');

// ---- inline markdown: bold, italic, links, footnotes
await page.evaluate(() => window.gn.load('first'));
await page.locator('.blk').first().click();
await page.keyboard.press('End');
await page.keyboard.press('Enter');
await page.keyboard.type('Some **bold** and *it* text with $x^2');
await page.keyboard.press('Escape');
await page.keyboard.type(' inside.');
check('typing markdown keeps the text exact', await md(), 'Some **bold** and *it* text with $x^{2}$ inside.');
check('bold renders as <strong>', await page.locator('.blk strong').innerText(), 'bold');
check('markers dimmed while editing', await page.evaluate(() => getComputedStyle(document.querySelector('.blk.editing .md-mark')).display), 'inline');
await page.locator('.blk').first().click();
check('markers hidden in other paragraphs', await page.evaluate(() => getComputedStyle(document.querySelectorAll('.blk')[1].querySelector('.md-mark')).display), 'none');

// ⌘B / ⌘I on a selection, and toggling back off.
await page.evaluate(() => window.gn.load('make this word bold'));
await page.locator('.blk').first().click();
await page.keyboard.press('End');
await page.keyboard.press('Alt+Shift+ArrowLeft');
await page.keyboard.press('Meta+b');
check('⌘B wraps the selection', await md(), 'make this word **bold**');
await page.keyboard.press('Meta+b');
check('⌘B again unwraps it', await md(), 'make this word bold');
await page.keyboard.press('Meta+i');
check('⌘I italicizes', await md(), 'make this word *bold*');

// A URL pasted over a selection becomes a link; ⌘-click would open it.
await page.evaluate(() => navigator.clipboard.writeText('https://example.org/x'));
await page.evaluate(() => window.gn.load('read the docs'));
await page.locator('.blk').first().click();
await page.keyboard.press('End');
for (let i = 0; i < 1; i++) await page.keyboard.press('Alt+Shift+ArrowLeft');
await page.keyboard.press('Meta+v');
check('URL pasted over text makes a link', await md(), 'read the [docs](https://example.org/x)');
check('link rendered', await page.locator('.md-link').getAttribute('data-href'), 'https://example.org/x');

// Footnotes: numbered by first appearance, definition text on hover, ⌘⌥F inserts the next one.
await page.evaluate(() => window.gn.load('Claim one[^a] and two[^b], again[^a], inline^[quick note].\n\n[^b]: Second source.\n\n[^a]: First source.'));
await page.locator('.blk').last().click(); // move the caret off the first paragraph
const fn = await page.evaluate(() => [...document.querySelectorAll('.blk')[0].querySelectorAll('.md-fnref, .md-fninline')].map((e) => e.dataset.n + ':' + e.title).join(' | '));
check('footnotes numbered in order, with note text', fn, '1:First source. | 2:Second source. | 1:First source. | 3:quick note');
check('definitions numbered to match', await page.evaluate(() => [...document.querySelectorAll('.fn-def')].map((e) => e.dataset.n).join(',')), '2,1');
await page.screenshot({ path: `${shots}/12-footnotes.png` });
await page.evaluate(() => window.gn.load('Euler wrote this'));
await page.locator('.blk').first().click();
await page.keyboard.press('End');
await page.keyboard.press('Meta+Alt+f');
await page.keyboard.type('Introductio, 1748.');
check('⌘⌥F adds a reference and its definition', await md(), 'Euler wrote this[^1]\n\n[^1]: Introductio, 1748.');

// Files round-trip exactly.
const sample = '# Notes on *series*\n\nThe sum $\\sum_{n}a_{n}$ is **absolutely** convergent[^1]; see [Rudin](https://example.org).\n\n> A ~~wrong~~ quote.\n\n[^1]: Rudin, ch. 3.\n';
await page.evaluate((m) => window.gn.load(m), sample);
check('markdown with formatting round-trips', await md(), sample);
await page.screenshot({ path: `${shots}/13-formatting.png` });

// Section numbers on headings (display only), {-} excluded.
await page.evaluate(() => window.gn.load('# Title {-}\n\n# Intro\n\n## Setup\n\n### Detail\n\n## Results\n\n# Next\n\n## More\n\nbody'));
await page.locator('.blk').last().click();
const nums = await page.evaluate(() => [...document.querySelectorAll('.blk[class*=" h"]')].map((b) => b.dataset.secnum ?? '-').join(' '));
check('headings numbered 1 / 1.1 / 1.1.1, {-} skipped', nums, '- 1 1.1 1.1.1 1.2 2 2.1');
check('numbers are not saved into the file', await md(), '# Title {-}\n\n# Intro');
await page.screenshot({ path: `${shots}/18-numbered.png` });

// ---- table of contents and theme
const long = ['# Analysis {-}', '# Sequences', 'text '.repeat(200), '## Limits of $a_{n}$', 'text '.repeat(200), '### Deep detail', 'more', '## Cauchy', 'text '.repeat(200), '# Series', 'text '.repeat(400)].join('\n\n');
await page.evaluate((m) => window.gn.load(m), long);
await page.waitForTimeout(100);
const tocText = await page.locator('#toc a').allInnerTexts();
check('contents list # and ## only, with numbers', tocText.map((t) => t.replace(/[\s\u200B]+/g, ' ').trim()).join(' | '), 'Analysis | 1 Sequences | 1.1 Limits of a n | 1.2 Cauchy | 2 Series');
check('equations in headings render in the contents', String(await page.locator('#toc .katex').count()), '1');
await page.locator('#toc a', { hasText: 'Cauchy' }).click();
await page.waitForTimeout(700);
const cauchyTop = await page.evaluate(() => [...document.querySelectorAll('.blk.h2')].find((b) => b.textContent.includes('Cauchy')).getBoundingClientRect().top);
check('clicking an entry scrolls to the heading', String(cauchyTop > 40 && cauchyTop < 140), 'true');
check('…and highlights it', await page.locator('#toc a.active').innerText().then((t) => t.replace(/\s+/g, ' ')), '1.2 Cauchy');
check('…and puts the caret there', await page.evaluate(() => getSelection().focusNode?.parentElement?.closest('.blk')?.textContent.includes('Cauchy')).then(String), 'true');
await page.screenshot({ path: `${shots}/19-toc-light.png` });
await page.click('#theme-btn'); // auto → light
await page.click('#theme-btn'); // light → dark
check('theme button switches to dark', await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
await page.waitForTimeout(350); // let the color transition finish
check('dark paper color applied', await page.evaluate(() => getComputedStyle(document.querySelector('.doc')).backgroundColor), 'rgb(28, 30, 34)');
await page.evaluate(() => window.gn.load('# Dark *mode* {-}\n\nText with $\\int_0^1 x\\,dx$, **bold**, a [link](https://x.org) and a note[^1].\n\n$$\n\\sum_{n=1}^{\\infty}\\frac{1}{n^{2}}=\\frac{\\pi^{2}}{6}\n$$\n\n> A quote.\n\n[^1]: The note.'));
await page.waitForTimeout(100);
await page.screenshot({ path: `${shots}/20-dark.png` });
await page.reload();
await page.waitForSelector('.math');
check('theme remembered after reload', await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
await page.click('#theme-btn'); // dark → auto
await page.evaluate(() => localStorage.removeItem('gn-theme'));

await page.screenshot({ path: `${shots}/6-final.png`, fullPage: true });
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
