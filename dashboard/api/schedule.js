// The kids' schedule from DHC tools (System A), proxied so the WebView only talks to this origin
// and never sees the display token. GET passes the ETag through (304 = nothing changed); POST
// forwards narrow ops (ticks, Phase 3 edits). Photo refs are rewritten to /api/schedule-photo.
import { isAuthorized, unauthorized } from '../lib/frame-key.js';
import { dhcFetch, isWeek, json, mondayISO, rewritePhotos, useFixture } from '../lib/dhc.js';
import { fixtureApply, fixtureDisplay, fixtureEtag } from '../lib/schedule-fixture.js';

const MAX_BODY = 16 * 1024;
const MAX_OPS = 20;

export async function GET(request) {
  if (!isAuthorized(request)) return unauthorized();
  const week = new URL(request.url).searchParams.get('week');
  if (week !== null && !isWeek(week)) return json({ error: 'bad-week' }, 400);
  const inm = request.headers.get('if-none-match');

  if (useFixture()) {
    const w = week || mondayISO(new Date());
    const etag = fixtureEtag(w);
    if (inm && inm === etag) return notModified(etag);
    return json(rewritePhotos(fixtureDisplay(w)), 200, { ETag: etag });
  }

  let upstream;
  try {
    upstream = await dhcFetch('/api/display/schedule' + (week ? `?week=${week}` : ''), {
      headers: inm ? { 'If-None-Match': inm } : {},
    });
  } catch (e) {
    return linkError(e);
  }
  if (upstream.status === 304) return notModified(upstream.headers.get('etag'));
  return relay(upstream);
}

export async function POST(request) {
  if (!isAuthorized(request)) return unauthorized();
  const type = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') return json({ error: 'bad-content-type' }, 415);
  const origin = request.headers.get('origin');
  const own = new URL(request.url).origin;
  if (origin !== own && request.headers.get('sec-fetch-site') !== 'same-origin') {
    return json({ error: 'forbidden' }, 403);
  }
  if (Number(request.headers.get('content-length')) > MAX_BODY) return json({ error: 'too-large' }, 413);
  const text = await request.text();
  if (Buffer.byteLength(text) > MAX_BODY) return json({ error: 'too-large' }, 413);

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: 'bad-json' }, 400);
  }
  const { week, ops } = body || {};
  if (!isWeek(week)) return json({ error: 'bad-week' }, 400);
  if (!Array.isArray(ops) || ops.length === 0) return json({ error: 'bad-ops' }, 400);
  if (ops.length > MAX_OPS) return json({ error: 'too-many-ops' }, 400);
  if (!ops.every((op) => op && typeof op === 'object' && !Array.isArray(op) && typeof op.op === 'string')) {
    return json({ error: 'bad-ops' }, 400);
  }

  if (useFixture()) {
    const result = fixtureApply(week, ops);
    if (result.status !== 200) return json(result.body, result.status);
    return json(rewritePhotos(result.body), 200, { ETag: fixtureEtag(week) });
  }

  let upstream;
  try {
    upstream = await dhcFetch('/api/display/schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ week, ops }),
    });
  } catch (e) {
    return linkError(e);
  }
  return relay(upstream);
}

function notModified(etag) {
  const headers = { 'Cache-Control': 'no-store' };
  if (etag) headers.ETag = etag;
  return new Response(null, { status: 304, headers });
}

function linkError(e) {
  if (e && e.code === 'not-linked') return json({ error: 'not-linked' }, 503);
  return json({ error: 'unreachable' }, 502);
}

// Upstream response -> frame response. Never logs payloads.
async function relay(upstream) {
  if (upstream.status === 401) return json({ error: 'unlinked' }, 401);
  let body = null;
  try {
    body = await upstream.json();
  } catch {
    body = null;
  }
  if (upstream.status === 200) {
    if (!body || typeof body !== 'object') return json({ error: 'bad-upstream' }, 502);
    const etag = upstream.headers.get('etag');
    // POST answers {display}; GET answers the display itself. The browser always gets the display.
    const display = body.display && typeof body.display === 'object' ? body.display : body;
    return json(rewritePhotos(display), 200, etag ? { ETag: etag } : {});
  }
  // 4xx (403 scope, 409 gone/full, 400) pass through; redirects and 5xx are upstream faults.
  if (upstream.status < 400 || upstream.status >= 500) return json({ error: 'upstream' }, 502);
  return json(body && typeof body === 'object' ? body : { error: 'upstream' }, upstream.status);
}
