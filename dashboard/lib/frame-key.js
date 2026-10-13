// The shared secret (FRAME_KEY, set in Vercel) that gates the dashboard and its photos.
// The frame opens /?key=…; the middleware then stores the key in a cookie for later requests.
export const COOKIE = 'frame_key';

export function keyFrom(request) {
  const fromQuery = new URL(request.url).searchParams.get('key');
  if (fromQuery) return fromQuery;
  const match = (request.headers.get('cookie') || '').match(/(?:^|;\s*)frame_key=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

export function isAuthorized(request) {
  const expected = process.env.FRAME_KEY;
  // No key outside Vercel means local dev (vite); on Vercel a missing key locks everything.
  if (!expected) return process.env.VERCEL !== '1';
  const got = keyFrom(request);
  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export function unauthorized() {
  return new Response('Unauthorized', { status: 401, headers: { 'Cache-Control': 'no-store' } });
}
