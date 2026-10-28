// Browser side of the AI features. The dev server (server/ai.ts) holds the API key.

export interface CompletionRequest {
  /** Document markdown with the equation being edited replaced by ⟦EQ⟧. */
  doc: string;
  /** LaTeX of the equation before / after the cursor. */
  before: string;
  after: string;
  display: boolean;
}

export interface GenerateRequest {
  doc: string;
  current: string;
  instruction: string;
  display: boolean;
}

export type AiStatus = 'idle' | 'busy' | 'offline' | 'error';

let listener: (s: AiStatus, msg?: string) => void = () => {};
export const onAiStatus = (fn: typeof listener) => (listener = fn);

let inflight = 0;

async function post(path: string, body: unknown, signal?: AbortSignal): Promise<string> {
  inflight++;
  listener('busy');
  try {
    const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
    const data = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
    if (!res.ok) {
      listener(res.status === 503 ? 'offline' : 'error', data.error);
      throw new Error(data.error ?? `HTTP ${res.status}`);
    }
    if (--inflight === 0) listener('idle');
    inflight = Math.max(inflight, 0);
    return cleanLatex(data.text ?? '');
  } catch (e) {
    inflight = Math.max(inflight - 1, 0);
    if ((e as Error).name === 'AbortError' && inflight === 0) listener('idle');
    throw e;
  }
}

/** Models sometimes wrap LaTeX in fences or dollars; strip that. */
export function cleanLatex(s: string): string {
  let t = s.trim();
  t = t.replace(/^```(?:latex|tex)?\s*/i, '').replace(/```$/, '').trim();
  t = t.replace(/^\$\$([\s\S]*)\$\$$/, '$1').replace(/^\$([\s\S]*)\$$/, '$1').replace(/^\\\[([\s\S]*)\\\]$/, '$1');
  return t.trim();
}

export const complete = (req: CompletionRequest, signal?: AbortSignal) => post('/api/complete', req, signal);
export const generate = (req: GenerateRequest, signal?: AbortSignal) => post('/api/generate', req, signal);
