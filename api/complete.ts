import { webHandler } from '../server/core.js';

// Vercel function for /api/complete.
export function POST(request: Request) {
  return webHandler('/api/complete', request);
}
