import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { type Body, clientOf, handleAi, ROUTES, type Route } from './core.js';

// Mounts the AI endpoints into Vite's dev and preview servers. On Vercel the same
// handlers run as functions (api/).

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

async function middleware(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const path = req.url?.split('?')[0] as Route;
  if (!ROUTES.includes(path)) return next();
  let gone = false;
  // The response's close (not the request's, which fires once the body is read) means the client left.
  res.on('close', () => (gone = !res.writableEnded));
  const body = req.method === 'POST' ? await readBody(req).catch(() => ({})) : {};
  const headers = { get: (n: string) => (req.headers[n] as string | undefined) ?? null };
  const reply = await handleAi(path, body, clientOf(headers, req.socket.remoteAddress ?? 'local'));
  if (gone) return;
  res.statusCode = reply.status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(reply.json));
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
