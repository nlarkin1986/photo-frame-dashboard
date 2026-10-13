// Vercel Routing Middleware: nothing on this site loads without the frame key — except the agent
// API (/api/agent/*) and the future MCP endpoint (/api/mcp), which authenticate every request
// themselves with per-agent bearer tokens (lib/board/tokens.js). /api/agent/openapi(.json) is public.
import { next } from '@vercel/functions';
import { COOKIE, isAuthorized, unauthorized } from './lib/frame-key.js';

export const config = { runtime: 'nodejs' };

// The pathname is already normalised by URL parsing (dot segments resolved), so a
// /api/agent/../board style path cannot slip past the frame key.
export function bypassesFrameKey(pathname) {
  return pathname.startsWith('/api/agent/') || pathname === '/api/mcp' || pathname.startsWith('/api/mcp/');
}

export default function middleware(request) {
  if (bypassesFrameKey(new URL(request.url).pathname)) return next();
  if (!isAuthorized(request)) return unauthorized();
  const key = new URL(request.url).searchParams.get('key');
  if (!key) return next();
  return next({
    headers: {
      'Set-Cookie': `${COOKIE}=${encodeURIComponent(key)}; Path=/; Max-Age=315360000; HttpOnly; Secure; SameSite=Lax`,
    },
  });
}
