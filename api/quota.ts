import { webHandler } from '../server/core.js';

// Vercel function for /api/quota.
export function GET(request: Request) {
  return webHandler('/api/quota', request);
}
