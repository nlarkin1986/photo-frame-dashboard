// A schedule photo (card, avatar or library entry) or a feeling picture, proxied from DHC tools
// (System A) so the WebView never talks to another origin. `v` changes whenever a photo does,
// so responses are immutable.
import { isAuthorized, unauthorized } from '../lib/frame-key.js';
import { dhcFetch, FEELING_RE, PHOTO_ID_RE, PHOTO_V_RE, useFixture } from '../lib/dhc.js';

const CACHE = 'private, max-age=31536000, immutable';

export async function GET(request) {
  if (!isAuthorized(request)) return unauthorized();
  const params = new URL(request.url).searchParams;
  const id = params.get('id');
  const v = params.get('v');
  const feeling = params.get('feeling');
  let path;
  if (feeling !== null && id === null && v === null) {
    if (!FEELING_RE.test(feeling)) return bad();
    path = `/api/display/photo?feeling=${feeling}`;
  } else if (feeling === null && id !== null && v !== null) {
    if (!PHOTO_ID_RE.test(id) || !PHOTO_V_RE.test(v)) return bad();
    path = `/api/display/photo?id=${id}&w=320`;
  } else {
    return bad();
  }

  if (useFixture()) {
    // Local dev: stand-in pictures from the picsum proxy, stable per id/feeling.
    const seed = (feeling ? `feeling-${feeling}` : `sched-${id}`).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 64);
    return new Response(null, {
      status: 302,
      headers: { Location: `/api/img?seed=${seed}&w=320&h=320`, 'Cache-Control': 'no-store' },
    });
  }

  let upstream;
  try {
    upstream = await dhcFetch(path);
  } catch (e) {
    const status = e && e.code === 'not-linked' ? 503 : 502;
    return new Response(status === 503 ? 'Not linked' : 'Upstream error', { status, headers: { 'Cache-Control': 'no-store' } });
  }
  if (!upstream.ok) {
    const status = upstream.status === 404 ? 404 : upstream.status === 401 ? 401 : 502;
    return new Response('Upstream error', { status, headers: { 'Cache-Control': 'no-store' } });
  }
  const type = upstream.headers.get('content-type') || 'image/jpeg';
  if (!/^image\//.test(type)) return new Response('Upstream error', { status: 502, headers: { 'Cache-Control': 'no-store' } });
  return new Response(upstream.body, { headers: { 'Content-Type': type, 'Cache-Control': CACHE } });
}

function bad() {
  return new Response('Bad request', { status: 400, headers: { 'Cache-Control': 'no-store' } });
}
