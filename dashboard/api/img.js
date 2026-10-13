import { isAuthorized, unauthorized } from '../lib/frame-key.js';

// Proxies the mock picsum photos through Vercel. The frame's Android 6 trust store rejects
// picsum's Let's Encrypt certificate, so the frame must only ever talk to this origin.
export async function GET(request) {
  if (!isAuthorized(request)) return unauthorized();
  const params = new URL(request.url).searchParams;
  const seed = params.get('seed') || '';
  const w = Number(params.get('w'));
  const h = Number(params.get('h'));
  const size = (n) => Number.isInteger(n) && n > 0 && n <= 2000;
  if (!/^[a-z0-9-]{1,64}$/.test(seed) || !size(w) || !size(h)) {
    return new Response('Bad request', { status: 400 });
  }
  const upstream = await fetch(`https://picsum.photos/seed/${seed}/${w}/${h}`);
  if (!upstream.ok) return new Response('Upstream error', { status: 502 });
  return new Response(upstream.body, {
    headers: {
      'Content-Type': upstream.headers.get('content-type') || 'image/jpeg',
      // A seed and size always map to the same image.
      'Cache-Control': 'public, max-age=86400, s-maxage=31536000, immutable',
    },
  });
}
