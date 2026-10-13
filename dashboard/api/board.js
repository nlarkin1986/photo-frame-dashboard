// The family board for the frame (shopping, chores, weekly brief, review queue).
// GET  -> board document (private items redacted), ETag "r<rev>", 304 when unchanged.
// POST {ops:[…]} -> frame write-back (FRAME_KEY cookie, same-origin, JSON ≤16 KB, ≤20 ops),
//      answers 200 { board } with the new document.
import { isAuthorized, unauthorized } from '../lib/frame-key.js';
import { errorResponse, etagOf, json, mutate, readFresh, SMALL_BODY } from '../lib/board/http.js';
import { applyFrameOps, FRAME_ACTOR, makeCtx } from '../lib/board/ops.js';
import { boardView } from '../lib/board/redact.js';
import { LIMITS, validateFrameOps } from '../lib/board/schema.js';
import { getStore } from '../lib/board/store.js';

function notModified(etag) {
  return new Response(null, { status: 304, headers: { 'Cache-Control': 'no-store', ETag: etag } });
}

export async function GET(request) {
  if (!isAuthorized(request)) return unauthorized();
  try {
    const store = await getStore();
    const inm = request.headers.get('if-none-match');
    // Cheap path for the 30–60 s poll: rev + day only.
    const ctx = makeCtx();
    const peek = await store.peek();
    if (inm && peek.day === ctx.today && inm === etagOf(peek.rev)) return notModified(inm);
    const { rev, doc, ctx: c } = await readFresh(store);
    if (inm && inm === etagOf(rev)) return notModified(inm);
    return json(boardView(doc, { today: c.today, week: c.week, audience: 'frame' }), 200, { ETag: etagOf(rev) });
  } catch (e) {
    return errorResponse(e);
  }
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
  if (Number(request.headers.get('content-length')) > SMALL_BODY) return json({ error: 'too-large' }, 413);
  const text = await request.text();
  if (Buffer.byteLength(text) > SMALL_BODY) return json({ error: 'too-large' }, 413);

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: 'bad-json' }, 400);
  }
  const ops = body && body.ops;
  if (!Array.isArray(ops) || ops.length === 0) return json({ error: 'bad-ops' }, 400);
  if (ops.length > LIMITS.frameOps) return json({ error: 'too-many-ops' }, 400);

  try {
    const valid = validateFrameOps(ops);
    const store = await getStore();
    const { rev } = await mutate(store, { actor: FRAME_ACTOR }, (doc, ctx) => applyFrameOps(doc, valid, ctx));
    const fresh = await readFresh(store);
    return json({ board: boardView(fresh.doc, { today: fresh.ctx.today, week: fresh.ctx.week, audience: 'frame' }) }, 200, { ETag: etagOf(fresh.rev ?? rev) });
  } catch (e) {
    return errorResponse(e);
  }
}
