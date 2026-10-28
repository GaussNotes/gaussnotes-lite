// Drives the editor in headless Chromium. Usage: node test/e2e.mjs [url] [shotDir]
import { chromium } from 'playwright';
const url = process.argv[2] ?? 'http://localhost:5199';
const shots = process.argv[3] ?? '.';
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
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

await page.screenshot({ path: `${shots}/6-final.png`, fullPage: true });
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
