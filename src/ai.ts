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

export type AiStatus = 'idle' | 'busy' | 'offline' | 'error' | 'spent';

/** Demo allowance from the server: limit null means unlimited. */
export interface Quota {
  used: number;
  limit: number | null;
}

let listener: (s: AiStatus, msg?: string) => void = () => {};
export const onAiStatus = (fn: typeof listener) => (listener = fn);
let quotaListener: (q: Quota) => void = () => {};
export const onQuota = (fn: typeof quotaListener) => (quotaListener = fn);

let quota: Quota = { used: 0, limit: null };
let spentMessage: string | null = null;
/** True once the demo allowance is used up: no more requests are sent. */
export const aiSpent = () => spentMessage !== null;

function setQuota(q: Quota | undefined) {
  if (!q) return;
  quota = q;
  quotaListener(q);
}

let inflight = 0;

async function post(path: string, body: unknown, signal?: AbortSignal): Promise<string> {
  if (spentMessage) throw new Error(spentMessage);
  inflight++;
  listener('busy');
  try {
    const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
    const data = (await res.json().catch(() => ({}))) as { text?: string; error?: string; quota?: Quota };
    setQuota(data.quota);
    if (res.status === 429 && data.quota) {
      spentMessage = data.error ?? 'Demo limit reached.';
      listener('spent', spentMessage);
      throw new Error(spentMessage);
    }
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

/** Tell the server a suggestion was accepted (that's what counts against the demo allowance). */
export async function reportAccepted() {
  if (quota.limit === null) return;
  const res = await fetch('/api/accept', { method: 'POST' }).catch(() => null);
  const data = (await res?.json().catch(() => ({}))) as { quota?: Quota } | undefined;
  setQuota(data?.quota);
}

/** Initial allowance, shown in the toolbar. */
export async function loadQuota() {
  const res = await fetch('/api/quota').catch(() => null);
  const data = (await res?.json().catch(() => ({}))) as { quota?: Quota } | undefined;
  setQuota(data?.quota);
  if (quota.limit !== null && quota.used >= quota.limit) {
    spentMessage = `That's the ${quota.limit} free AI completions for this demo. Thanks for trying GaussNotes!`;
    listener('spent', spentMessage);
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
