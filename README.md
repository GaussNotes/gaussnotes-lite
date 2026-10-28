# GaussNotes Lite

A small rewrite of the [GaussNotes](https://github.com/GaussNotes/gaussnotes) equation editor in TypeScript: one markdown document, inline and display equations you edit structurally, and an AI co-pilot for equations. There's no Flutter and no framework. The dependencies are KaTeX, Vite, and the Anthropic SDK.

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...   # only needed for the AI features
npm run dev                            # http://localhost:5173
```

## Writing

- The document is plain markdown. **Open** and **Save** use the File System Access API in Chromium browsers and fall back to upload/download elsewhere. A draft autosaves to localStorage.
- Typing `$` starts inline math. Typing `$` again in an empty equation on an empty line turns it into display math (`$$…$$`).
- Inside an equation:
  - `^` and `_` make scripts. `/` makes a fraction and pulls the preceding term into the numerator.
  - `(`, `[`, `{` and `|` make brackets. Typing the closing character steps out.
  - Keywords convert on space, or when you type the next symbol: `alpha`, `sum`, `int`, `sqrt`, `RR`, `pmat2x3`, `sys2`, `text`, … `\anything` + space works for any command.
  - Shortcuts convert as you type: `<=` `>=` `!=` `->` `=>` `+-` `...`
  - Arrow keys walk the structure, and ↑/↓ move between numerator and denominator, sub and sup, or matrix rows. Space at the end of a slot steps out of it.
  - Clicking anywhere in a rendered equation puts the cursor at that spot.
- ⌘Z / ⇧⌘Z undo and redo across both text and math.

## AI

- **Ghost completion:** when you pause while typing an equation, the model is asked what to insert at the cursor. The answer shows in gray. **Tab** accepts it, typing a matching character keeps the rest of it, and anything else dismisses it. Turn it off with the *Autocomplete* toggle.
- **⌘K:** describe an equation in words. In text, this inserts a new equation (display math if the line is empty). Inside an equation, it rewrites that equation according to your instruction.

The API key stays on the server. `server/ai.ts` is a Vite plugin that serves `POST /api/complete` and `POST /api/generate` during `npm run dev` and `npm run preview`. Both use `claude-opus-5-5` (completion at `low` effort, generation at `medium`) with server-side refusal fallback. To trade quality for lower ghost-text latency, override the models with `GAUSS_COMPLETE_MODEL` and `GAUSS_GENERATE_MODEL`.

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

## Tests

```bash
npm test                 # unit tests: LaTeX round-trip, typing, navigation, markdown
npm run dev &            # then, with a Chromium build available:
node test/e2e.mjs http://localhost:5173 /tmp   # drives the real editor (AI calls mocked)
```

`test/e2e.mjs` reads `CHROME_PATH` if Playwright's bundled browser isn't installed.

## Limits

- Text is stored and shown verbatim. Headings and quotes get styling, but there is no bold or italic rendering.
- No selection inside equations yet.
- `$` inside code spans in a markdown file will be read as math.
