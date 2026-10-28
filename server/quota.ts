// Demo allowance for the shared DeepSeek key, per day (GAUSS_DEMO_WINDOW_HOURS):
//
// - Each visitor (by IP) gets GAUSS_DEMO_COMPLETIONS (20) completions: accepted suggestions
//   (Tab) and ⌘K generations. Suggestions that are shown and ignored don't count.
// - What DeepSeek bills is requests, and ignored suggestions are requests too, so two caps
//   bound the bill: GAUSS_DEMO_GLOBAL_DAILY (500) requests site-wide, and
//   GAUSS_DEMO_REQUESTS (100) per visitor so one person can't use up the site's share.
//
// Counters live in Upstash Redis when its REST env vars are set (Vercel marketplace
// integration), else in memory, which is fine locally but resets per serverless instance.

const env = process.env;
const onVercel = !!env.VERCEL;
const num = (v: string | undefined, d: number | null) => (v === undefined || v === '' ? d : Number(v));

/** null = unlimited (the default when running locally). */
export const LIMIT = num(env.GAUSS_DEMO_COMPLETIONS, onVercel ? 20 : null);
const REQUESTS = num(env.GAUSS_DEMO_REQUESTS, LIMIT === null ? null : 100);
const GLOBAL_DAILY = num(env.GAUSS_DEMO_GLOBAL_DAILY, LIMIT === null ? null : 500);
const WINDOW_S = Math.round((num(env.GAUSS_DEMO_WINDOW_HOURS, 24) ?? 24) * 3600);

const REDIS_URL = env.KV_REST_API_URL ?? env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = env.KV_REST_API_TOKEN ?? env.UPSTASH_REDIS_REST_TOKEN;

if (onVercel && LIMIT !== null && !REDIS_URL) console.warn('[quota] No Upstash Redis configured: demo limits are per instance and reset often.');

// ---- storage ---------------------------------------------------------------

const memory = new Map<string, { n: number; expires: number }>();

async function redis(commands: (string | number)[][]): Promise<(number | string | null)[]> {
  const res = await fetch(`${REDIS_URL}/pipeline`, {
    method: 'POST',
    headers: { authorization: `Bearer ${REDIS_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(commands),
  });
  if (!res.ok) throw new Error(`Redis HTTP ${res.status}`);
  return ((await res.json()) as { result: number | string | null }[]).map((r) => r.result);
}

async function get(keys: string[]): Promise<number[]> {
  if (REDIS_URL) return (await redis(keys.map((k) => ['GET', k]))).map((v) => Number(v ?? 0));
  const now = Date.now();
  return keys.map((k) => {
    const e = memory.get(k);
    return e && e.expires > now ? e.n : 0;
  });
}

async function incr(key: string, ttl: number): Promise<number> {
  if (REDIS_URL) return Number((await redis([['INCR', key], ['EXPIRE', key, ttl, 'NX']]))[0]);
  const now = Date.now();
  const e = memory.get(key);
  const next = e && e.expires > now ? { n: e.n + 1, expires: e.expires } : { n: 1, expires: now + ttl * 1000 };
  memory.set(key, next);
  return next.n;
}

// ---- policy ------------------------------------------------------------------

const day = () => new Date().toISOString().slice(0, 10);
const keys = (client: string) => ({ used: `gn:used:${client}`, calls: `gn:calls:${client}`, global: `gn:global:${day()}` });

export interface Quota {
  used: number;
  limit: number | null;
}

export class QuotaError extends Error {
  constructor(
    message: string,
    readonly quota: Quota,
  ) {
    super(message);
  }
}

export async function status(client: string): Promise<Quota> {
  if (LIMIT === null) return { used: 0, limit: null };
  const [used] = await get([keys(client).used]);
  return { used, limit: LIMIT };
}

/** Before a model call: refuse if any allowance is spent, else count the call. */
export async function beforeCall(client: string): Promise<void> {
  if (LIMIT === null) return;
  const k = keys(client);
  const [used, calls, global] = await get([k.used, k.calls, k.global]);
  const quota = { used, limit: LIMIT };
  if (used >= LIMIT) throw new QuotaError(`That's the ${LIMIT} free AI completions for this demo. Thanks for trying GaussNotes!`, quota);
  if (REQUESTS !== null && calls >= REQUESTS) throw new QuotaError('AI request limit reached for today. Thanks for trying GaussNotes!', quota);
  if (GLOBAL_DAILY !== null && global >= GLOBAL_DAILY) throw new QuotaError('The demo has hit its AI budget for today. Please come back tomorrow.', quota);
  await incr(k.calls, WINDOW_S);
  await incr(k.global, 26 * 3600);
}

/** A completion was used: an accepted suggestion or a ⌘K generation. */
export async function countCompletion(client: string): Promise<Quota> {
  if (LIMIT === null) return { used: 0, limit: null };
  const k = keys(client);
  const used = await incr(k.used, WINDOW_S);
  return { used, limit: LIMIT };
}
