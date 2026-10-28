import { webHandler } from '../server/core.js';

// Vercel function for /api/generate (⌘K). Reasoning can take a while on hard requests.
export const config = { maxDuration: 60 };

export function POST(request: Request) {
  return webHandler('/api/generate', request);
}
