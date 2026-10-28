import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

// Keeps the API key on the server. Mounted into Vite's dev and preview servers.

const BASE_URL = process.env.GAUSS_AI_BASE_URL ?? 'https://api.deepseek.com';
const COMPLETE_MODEL = process.env.GAUSS_COMPLETE_MODEL ?? 'deepseek-flash'; // DeepSeek-V4.1-Flash
const GENERATE_MODEL = process.env.GAUSS_GENERATE_MODEL ?? 'deepseek-flash';
const MAX_DOC = 24_000;

const COMPLETE_SYSTEM = `You are the inline autocomplete engine of GaussNotes, a math notes editor. The user is typing a LaTeX equation and you predict what comes next, shown to them as gray ghost text they can accept with Tab.

Output ONLY the LaTeX to insert at the cursor: no $ delimiters, no code fences, no commentary. Never repeat what is already before the cursor. The cursor can sit inside a group (a fraction numerator, an exponent, parentheses); your insertion goes at that exact point, so it must be balanced on its own (every brace you open, you close) and must read correctly followed by the text after the cursor. Prefer the natural completion of the current expression or equation, using the surrounding notes for notation and intent. Keep it short: at most the rest of the current equation. If there is no confident completion, output nothing.`;

const GENERATE_SYSTEM = `You write LaTeX math for GaussNotes, a math notes editor. Given an instruction (and possibly the current equation), return the equation as LaTeX that KaTeX can render.

Output ONLY the LaTeX: no $ or \\[ delimiters, no code fences, no commentary. If a current equation is given, return the full edited equation. Match the notation of the surrounding notes. For several aligned lines in display math, use \\begin{aligned} ... \\end{aligned}.`;

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// DeepSeek's OpenAI-compatible chat endpoint.
async function ask(model: string, system: string, user: string, effort: 'low' | 'high', maxTokens: number): Promise<string> {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new ApiError(503, 'No DeepSeek key: set DEEPSEEK_API_KEY and restart the server.');
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      reasoning_effort: effort,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    choices?: { message?: { content?: string } }[];
    error?: { message?: string };
  };
  if (!res.ok) {
    const msg = data.error?.message ?? `DeepSeek HTTP ${res.status}`;
    throw new ApiError(res.status === 401 ? 503 : res.status === 429 ? 429 : 502, msg);
  }
  return (data.choices?.[0]?.message?.content ?? '').trim();
}

const clip = (doc: string) => {
  if (doc.length <= MAX_DOC) return doc;
  const at = Math.max(doc.indexOf('⟦EQ⟧'), 0);
  const start = Math.max(0, Math.min(at - MAX_DOC * 0.75, doc.length - MAX_DOC));
  return doc.slice(start, start + MAX_DOC);
};

interface Body {
  doc?: string;
  before?: string;
  after?: string;
  current?: string;
  instruction?: string;
  display?: boolean;
}

async function handle(path: string, body: Body): Promise<string> {
  const kind = body.display ? 'display' : 'inline';
  const doc = `<notes>\n${clip(body.doc ?? '')}\n</notes>\n\nThe equation being edited is the ${kind} equation marked ⟦EQ⟧.`;
  if (path === '/api/complete') {
    const user = `${doc}\n\n<before_cursor>${body.before ?? ''}</before_cursor>\n<after_cursor>${body.after ?? ''}</after_cursor>\n\nLaTeX to insert at the cursor:`;
    return ask(COMPLETE_MODEL, COMPLETE_SYSTEM, user, 'low', 2000);
  }
  const current = body.current ? `\n\n<current_equation>${body.current}</current_equation>` : '';
  const user = `${doc}${current}\n\n<instruction>${body.instruction ?? ''}</instruction>`;
  return ask(GENERATE_MODEL, GENERATE_SYSTEM, user, 'high', 8000);
}

function readBody(req: IncomingMessage): Promise<Body> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, payload: object) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(payload));
}

async function middleware(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const path = req.url?.split('?')[0];
  if (req.method !== 'POST' || (path !== '/api/complete' && path !== '/api/generate')) return next();
  let aborted = false;
  // The response's close (not the request's, which fires once the body is read) means the client left.
  res.on('close', () => (aborted = !res.writableEnded));
  try {
    const text = await handle(path, await readBody(req));
    if (!aborted) send(res, 200, { text });
  } catch (e) {
    if (e instanceof ApiError) return send(res, e.status, { error: e.message });
    send(res, 500, { error: (e as Error).message });
  }
}

export function aiPlugin(): Plugin {
  return {
    name: 'gauss-ai',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
