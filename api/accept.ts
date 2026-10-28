import { webHandler } from '../server/core.js';

// Vercel function for /api/accept.
export function POST(request: Request) {
  return webHandler('/api/accept', request);
}
