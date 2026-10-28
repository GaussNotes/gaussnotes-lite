import 'katex/dist/katex.min.css';
import './style.css';
import { onAiStatus } from './ai';
import { DocEditor } from './doc/document';
import { settings } from './math/editing';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const WELCOME = `# Welcome to GaussNotes Lite

Type text as usual. Press \\$ to write inline math like $e^{i\\pi}+1=0$, or press \\$ twice on an empty line for display math:

$$
\\int_{-\\infty}^{\\infty} e^{-x^{2}}\\,dx=\\sqrt{\\pi}
$$

Inside an equation, try typing  x^2 space + y/2  or  sum i=1 space n space . Click anywhere in an equation to put the cursor there. Press ⌘K to describe an equation in words, and Tab to accept gray suggestions.
`;

// ---- file handling (File System Access API when available, download/upload otherwise)

type Handle = { name: string; getFile(): Promise<File>; createWritable(): Promise<{ write(d: string): Promise<void>; close(): Promise<void> }> };
type Picker = (o: object) => Promise<Handle | Handle[]>;
const w = window as unknown as { showOpenFilePicker?: Picker; showSaveFilePicker?: Picker };
const MD_TYPES = { types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md', '.markdown', '.txt'] } }] };

let handle: Handle | null = null;
let filename = 'Untitled.md';
let saved = '';

const doc = new DocEditor($('doc'), $<HTMLTextAreaElement>('math-input'), {
  onChange: () => {
    updateTitle();
    clearTimeout(autosave);
    autosave = window.setTimeout(() => localStorage.setItem('gn-draft', JSON.stringify({ md: doc.markdown(), filename })), 500);
  },
  prompt: openPrompt,
  aiEnabled: () => $<HTMLInputElement>('ai-toggle').checked,
});
let autosave = 0;

function updateTitle() {
  const el = $('filename');
  el.textContent = filename;
  el.classList.toggle('dirty', doc.markdown() !== saved);
  document.title = `${filename} — GaussNotes Lite`;
}

function setDoc(md: string, name: string, h: Handle | null, isSaved: boolean) {
  doc.load(md);
  filename = name;
  handle = h;
  saved = isSaved ? doc.markdown() : '';
  updateTitle();
}

async function openFile() {
  try {
    if (w.showOpenFilePicker) {
      const [h] = (await w.showOpenFilePicker(MD_TYPES)) as Handle[];
      setDoc(await (await h.getFile()).text(), h.name, h, true);
      return;
    }
  } catch (e) {
    if ((e as Error).name === 'AbortError') return;
  }
  const inp = Object.assign(document.createElement('input'), { type: 'file', accept: '.md,.markdown,.txt,text/markdown' });
  inp.onchange = async () => {
    const f = inp.files?.[0];
    if (f) setDoc(await f.text(), f.name, null, true);
  };
  inp.click();
}

async function saveFile() {
  const md = doc.markdown();
  try {
    if (!handle && w.showSaveFilePicker) handle = (await w.showSaveFilePicker({ suggestedName: filename, ...MD_TYPES })) as Handle;
    if (handle) {
      const out = await handle.createWritable();
      await out.write(md);
      await out.close();
      filename = handle.name;
    } else {
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([md], { type: 'text/markdown' })), download: filename });
      a.click();
      URL.revokeObjectURL(a.href);
    }
    saved = md;
    updateTitle();
    flash(`Saved ${filename}`);
  } catch (e) {
    if ((e as Error).name !== 'AbortError') flash(`Save failed: ${(e as Error).message}`);
  }
}

function newFile() {
  if (doc.markdown() !== saved && doc.markdown().trim() && !confirm('Discard unsaved changes?')) return;
  setDoc('', 'Untitled.md', null, false);
  doc.setPos({ b: 0, off: 0 });
}

// ---- ⌘K prompt

function openPrompt(anchor: DOMRect | null, label: string): Promise<string | null> {
  const box = $('prompt');
  const input = $<HTMLInputElement>('prompt-input');
  input.placeholder = label;
  input.value = '';
  const r = anchor ?? new DOMRect(innerWidth / 2 - 260, 120, 0, 0);
  box.hidden = false;
  box.style.left = `${Math.max(8, Math.min(r.left, innerWidth - box.offsetWidth - 8)) + scrollX}px`;
  box.style.top = `${r.bottom + 8 + scrollY}px`;
  input.focus();
  return new Promise((resolve) => {
    const done = (v: string | null) => {
      box.hidden = true;
      input.removeEventListener('keydown', key);
      input.removeEventListener('blur', blur);
      resolve(v);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && input.value.trim()) {
        e.preventDefault();
        done(input.value.trim());
      } else if (e.key === 'Escape') {
        e.preventDefault();
        done(null);
      }
    };
    const blur = () => done(null);
    input.addEventListener('keydown', key);
    input.addEventListener('blur', blur);
  });
}

// ---- misc UI

let flashTimer = 0;
function flash(msg: string) {
  const el = $('flash');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => (el.hidden = true), 3200);
}
document.addEventListener('gn-flash', (e) => flash((e as CustomEvent<string>).detail));

let warned = false;
onAiStatus((s, msg) => {
  const el = $('ai-status');
  el.className = `ai-status ${s}`;
  el.title = msg ?? `AI: ${s}`;
  if ((s === 'offline' || s === 'error') && msg && !warned) {
    warned = true;
    flash(msg);
  }
});

const instant = $<HTMLInputElement>('instant-toggle');
instant.checked = localStorage.getItem('gn-instant') !== '0';
settings.instantKeywords = instant.checked;
instant.onchange = () => {
  settings.instantKeywords = instant.checked;
  localStorage.setItem('gn-instant', instant.checked ? '1' : '0');
};

$('new').onclick = newFile;
$('open').onclick = openFile;
$('save').onclick = saveFile;
$('help-btn').onclick = () => $<HTMLDialogElement>('help').showModal();
document.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey)) return;
  const k = e.key.toLowerCase();
  if (k === 's') {
    e.preventDefault();
    void saveFile();
  } else if (k === 'o') {
    e.preventDefault();
    void openFile();
  }
});
window.addEventListener('beforeunload', (e) => {
  if (handle && doc.markdown() !== saved) e.preventDefault();
});

// ---- boot: restore the last draft, else the welcome page

const draft = (() => {
  try {
    return JSON.parse(localStorage.getItem('gn-draft') ?? 'null') as { md: string; filename: string } | null;
  } catch {
    return null;
  }
})();
if (draft?.md?.trim()) setDoc(draft.md, draft.filename || 'Untitled.md', null, false);
else setDoc(WELCOME, 'Welcome.md', null, true);

// Exposed for debugging and tests.
(window as unknown as { gn: DocEditor }).gn = doc;
