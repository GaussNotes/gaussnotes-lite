import { beforeAll, describe, expect, it, vi } from 'vitest';

// The Vercel handlers with a 3-completion demo allowance; DeepSeek is mocked.
let handlers: { complete: (r: Request) => Promise<Response>; generate: (r: Request) => Promise<Response>; accept: (r: Request) => Promise<Response>; quota: (r: Request) => Promise<Response> };
let modelCalls = 0;

beforeAll(async () => {
  process.env.GAUSS_DEMO_COMPLETIONS = '3';
  process.env.GAUSS_DEMO_REQUESTS = '8';
  process.env.GAUSS_DEMO_GLOBAL_DAILY = '20';
  process.env.DEEPSEEK_API_KEY = 'test';
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (String(url).includes('deepseek')) {
      modelCalls++;
      return Response.json({ choices: [{ message: { content: 'x^{2}' } }] });
    }
    return realFetch(url, init);
  });
  handlers = {
    complete: (await import('../api/complete')).POST,
    generate: (await import('../api/generate')).POST,
    accept: (await import('../api/accept')).POST,
    quota: (await import('../api/quota')).GET,
  };
});

const req = (ip: string, body: object = {}) => new Request('https://x/api', { method: 'POST', headers: { 'x-forwarded-for': `${ip}, 10.0.0.1` }, body: JSON.stringify(body) });
const json = async (r: Promise<Response>) => {
  const res = await r;
  return { status: res.status, ...((await res.json()) as { text?: string; error?: string; quota?: { used: number; limit: number } }) };
};

describe('demo allowance', () => {
  it('suggestions only count when accepted; ⌘K counts', async () => {
    for (let i = 0; i < 3; i++) expect((await json(handlers.complete(req('1.1.1.1')))).quota).toEqual({ used: 0, limit: 3 });
    expect((await json(handlers.accept(req('1.1.1.1')))).quota).toEqual({ used: 1, limit: 3 });
    expect((await json(handlers.generate(req('1.1.1.1', { instruction: 'x' })))).quota).toEqual({ used: 2, limit: 3 });
    await handlers.accept(req('1.1.1.1'));
    const spent = await json(handlers.complete(req('1.1.1.1')));
    expect(spent.status).toBe(429);
    expect(spent.error).toMatch(/3 free AI completions/);
    // other visitors are unaffected, and the refused call didn't reach the model
    const calls = modelCalls;
    expect((await json(handlers.quota(new Request('https://x/api', { headers: { 'x-forwarded-for': '2.2.2.2' } })))).quota).toEqual({ used: 0, limit: 3 });
    expect(modelCalls).toBe(calls);
  });
  it('caps model calls even when nothing is accepted', async () => {
    for (let i = 0; i < 8; i++) expect((await json(handlers.complete(req('3.3.3.3')))).status).toBe(200);
    const r = await json(handlers.complete(req('3.3.3.3')));
    expect(r.status).toBe(429);
    expect(r.error).toMatch(/request limit/);
  });
  it('stops everyone once the site-wide daily requests are used', async () => {
    // 3 + 1 + 8 requests so far (accepts aren't requests); 8 more from new visitors reach 20
    for (let i = 0; i < 8; i++) expect((await json(handlers.complete(req(`9.9.9.${i}`)))).status).toBe(200);
    const r = await json(handlers.complete(req('8.8.8.8')));
    expect(r.status).toBe(429);
    expect(r.error).toMatch(/budget for today/);
  });
});
