# GaussNotes Lite

A small rewrite of the [GaussNotes](https://github.com/GaussNotes/gaussnotes) equation editor in TypeScript: one markdown document, inline and display equations you edit structurally, and an AI co-pilot for equations. There's no Flutter and no framework. The only runtime dependency is KaTeX, plus Vite for the dev server.

```bash
npm install
export DEEPSEEK_API_KEY=sk-...        # only needed for the AI features
npm run dev                            # http://localhost:5173
```

## Writing

- Text formatting renders live while the file stays plain markdown:
  - `**bold**` / `__bold__`, `*italic*` / `_italic_`, `***both***`, `~~strike~~`, `[text](url)`, headings `#` to `######`, and `> quotes`.
  - The markers show (dimmed) only in the paragraph holding the caret; elsewhere you see just the result.
  - ⌘B / ⌘I toggle bold / italic. Pasting a URL over selected text makes a link, and ⌘-click opens one.
- Footnotes use Pandoc syntax: `[^label]` references with `[^label]: …` definition paragraphs, and inline `^[…]` notes. They're numbered by first appearance and show their text on hover. ⌘⌥F inserts the next reference and its definition at the end of the document.
- Headings get section numbers (1, 1.1, 1.1.1, …) like Pandoc's `--number-sections`. The numbers are display only, never written to the file, and *Number headings* in the toolbar turns them off. End a heading with `{-}` (or `{.unnumbered}`) to leave it unnumbered, e.g. a title.
- The document is plain markdown. **Open** and **Save** use the File System Access API in Chromium browsers and fall back to upload/download elsewhere. A draft autosaves to localStorage.
- Typing `$` starts inline math. Typing `$` again in an empty equation on an empty line turns it into display math (`$$…$$`).
- Inside an equation:
  - `^` and `_` make scripts. `/` makes a fraction and pulls the preceding term into the numerator.
  - `(` and `{` make brackets. Typing the closing character steps out. `[`, `|` and `||` stay bare (intervals like `[0,1)`, "divides"); press Tab right after one to make it a bracket / absolute value / norm.
  - Keywords: `alpha`, `sum`, `int`, `sqrt`, `RR`, `pmat2x3`, `sys2`, `text`, … With **Instant symbols** on (the default), a keyword converts the moment you finish typing it. Words that could still grow wait for the next character: `sin` waits in case you're typing `sinh`, and `sinx` gives `\sin x`. With it off, keywords convert on space or Tab. `\anything` + space works for any command.
  - `sum`, `prod`, `int`, `oint`, `Cup`… come with empty lower and upper limit slots, and `lim` and `log` with a lower one. Slots left empty aren't saved. A `/` typed after a limit doesn't pull the limit into the numerator.
  - The full shortcut table of the original GaussNotes is ported (`src/math/keywords.ts`). Examples: `sr` / `cb` (squared / cubed), `td` / `tt` (exponent slot), `ddx` / `ddel` (derivative fractions), `pii`, `inn`, `too`, `xx`, `AA` / `EE`, `NN` / `RR` / `Exp`, `o++` / `oxx` / `u++`, `sub=` / `not=` / `<=>`, `||` (norm), `vec` / `hat` / `bb` / `cal` / `red`, `tend` (labelled arrow), `tr` / `rank` / `sgn`. The `?` button lists them.
  - Which keywords convert as you type follows the original exactly (its `isAuto` names and `autoAliases`). Plain aliases such as `pi`, `in`, `to`, `cdot` and `!=` need space or Tab, as do keywords added here that the original didn't have.
  - Keywords whose longer forms mean the same thing (`lim`/`limsup` aside, `int`/`integer`, `tr`/`trace`) convert immediately. Ones that might become something different (`sin`→`sinh`, `del`→`delta`, `pi`→`pii`) wait one character, or convert right away on Tab/space.
  - Shortcuts convert as you type: `<=` `>=` `!=` `->` `=>` `+-` `...`
  - Arrow keys walk the structure. → at the end of any slot (exponent, subscript, numerator, root, brackets, matrix cell, limits) lands just after the whole object, still in the equation; another → leaves it. ← works the same way. ↑/↓ move between numerator and denominator, sub and sup, or matrix rows. Space at the end of a slot steps out of it. `^` at the end of a subscript (or `_` at the end of a superscript) adds the other script beside it rather than nesting it.
  - Clicking anywhere in a rendered equation puts the cursor at that spot.
- Selecting inside an equation: Shift+←/→ (it grows by whole nodes and, at the edge of a slot, to the whole fraction/script/bracket), mouse drag, Shift+click, ⌘A. With a selection, `(` wraps it in brackets, `/` makes it a numerator, and any other key replaces it.
- Clipboard: ⌘C / ⌘X in an equation copy the selection (or the whole equation) as plain LaTeX. Pasting LaTeX into an equation parses it into structure. Pasting into text makes an inline equation when the content came from an equation, and `\(…\)` / `\[…\]` from elsewhere become inline / display math. Copying a text selection gives markdown with `$…$`.
- ⌘Z / ⇧⌘Z undo and redo across both text and math.

## AI

- **Ghost completion:** when you pause while typing an equation, the model is asked what to insert at the cursor. The answer shows in gray. **Tab** accepts it, typing a matching character keeps the rest of it, and anything else dismisses it. Turn it off with the *Autocomplete* toggle.
- **⌘K:** describe an equation in words. In text, this inserts a new equation (display math if the line is empty). Inside an equation, it rewrites that equation according to your instruction.

The API key stays on the server. `server/ai.ts` is a Vite plugin that serves `POST /api/complete` and `POST /api/generate` during `npm run dev` and `npm run preview`. Both call DeepSeek-V4.1-Flash (`deepseek-flash`) through DeepSeek's OpenAI-compatible chat endpoint: completion at `low` reasoning effort, generation at `high`. A suggestion takes about 2 seconds. Override with `GAUSS_COMPLETE_MODEL`, `GAUSS_GENERATE_MODEL`, and `GAUSS_AI_BASE_URL` (any OpenAI-compatible endpoint).

LaTeX that comes from the model, the clipboard, or a file is normalized on the way in. Matched `( )`, `[ ]`, `\{ \}` and `\langle \rangle` pairs, and sized ones like `\bigl( \bigr)`, become `\left…\right` structures, so they navigate like brackets you typed. A suggestion that ends by closing the bracket you're in steps out of it rather than adding a stray `)`. If KaTeX rejects the instrumented render (some constructs can't sit inside `\htmlData`), the equation is rendered again with those parts unwrapped, so it stays editable.

## How it works

| File | Role |
|---|---|
| `src/math/model.ts` | Equation tree. A *row* is a list of nodes: symbols, raw LaTeX, or structures (`frac`, `sup`, `delim`, `matrix`, `text`, …) that own slot rows. A cursor is a path of `(node, slot)` steps plus an offset. |
| `src/math/editing.ts` | Pure edits on `(root, cursor)`: movement, typing, keywords, backspace that dissolves structures. |
| `src/math/latex.ts` | LaTeX in both directions. The parser covers the structures above. Anything else becomes a raw node and round-trips verbatim. |
| `src/math/island.ts` | One rendered equation. It is rendered with KaTeX from *instrumented* LaTeX: every node is wrapped in `\htmlData{n=<id>}{…}`, so the DOM maps back to model positions. The tight ink box of each node gives caret positions. A click picks the innermost row whose box contains the point, then the nearest gap in that row. The caret is an overlay positioned from the same geometry. |
| `src/doc/document.ts` | `contenteditable` document. Equations are `contenteditable=false` islands. While one is active, keystrokes go to a hidden textarea (this handles IME and dead keys, e.g. `^` on AZERTY). Caret positions are measured in units where each inline equation counts as one character. |
| `src/doc/history.ts` | Snapshot undo: markdown plus caret, with rapid edits merged into one step. |
| `src/doc/markdown.ts` | Markdown ↔ blocks. |
| `src/doc/inline.ts` | Inline markdown (emphasis, links, footnotes, heading prefixes) → decorated DOM for a paragraph. The paragraph is rebuilt from its text after each edit, and the caret is restored by text offset. |

## Tests

```bash
npm test                 # unit tests: LaTeX round-trip, typing, navigation, markdown
npm run dev &            # then, with a Chromium build available:
node test/e2e.mjs http://localhost:5173 /tmp   # drives the real editor (AI calls mocked)
```

`test/e2e.mjs` reads `CHROME_PATH` if Playwright's bundled browser isn't installed.

## Limits

- Lists, tables, code blocks and images are kept as plain text (no special rendering).
- `$` inside code spans in a markdown file will be read as math.
