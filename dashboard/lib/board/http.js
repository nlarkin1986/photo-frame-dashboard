// HTTP plumbing shared by the agent REST handlers (api/agent/*) and the frame endpoint (api/board.js):
// JSON responses, bearer auth + scopes, rate limits, body limits, idempotency keys, error mapping,
// and the CAS write helper that also rolls the board over to a new day.
import crypto from 'node:crypto';
import { getStore, NotConfiguredError } from './store.js';
import { makeCtx, needsRollover, OpError, rollover } from './ops.js';
import { KEY_RE, ValidationError } from './schema.js';
import { rateLimit, resolveToken } from './tokens.js';

export const SMALL_BODY = 16 * 1024;
export const BRIEF_BODY = 64 * 1024;
export const IDEM_TTL = 7 * 24 * 3600;
export const IDEM_PENDING_TTL = 120;

export function json(body, status = 200, headers = {}) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

export const etagOf = (rev, variant = '') => `"r${rev}${variant ? '-' + variant : ''}"`;

export function parseIfMatch(v) {
  if (v == null || v === '') return { ok: true, rev: null };
  const m = /^\s*(?:W\/)?"r(\d{1,15})(?:-[A-Za-z0-9-]*)?"\s*$/.exec(v);
  return m ? { ok: true, rev: Number(m[1]) } : { ok: false };
}

export function errorResponse(e) {
  if (e instanceof NotConfiguredError) return json({ error: 'not-configured' }, 503);
  if (e instanceof ValidationError) return json({ error: e.status === 400 ? 'bad-ops' : 'invalid', details: e.details }, e.status);
  if (e instanceof OpError) return json({ error: e.error, ...e.extra }, e.status);
  if (e instanceof HttpError) return json(e.body, e.status, e.headers);
  console.error('[board]', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e);
  return json({ error: 'internal' }, 500);
}

export class HttpError extends Error {
  constructor(status, body, headers = {}) {
    super(body.error);
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

// Content-Type, size and JSON checks. Returns the parsed body and its raw text.
export async function readJson(request, max) {
  const type = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, { error: 'bad-content-type' });
  if (Number(request.headers.get('content-length')) > max) throw new HttpError(413, { error: 'too-large' });
  const text = await request.text();
  if (Buffer.byteLength(text) > max) throw new HttpError(413, { error: 'too-large' });
  try {
    return { body: JSON.parse(text), text };
  } catch {
    throw new HttpError(400, { error: 'bad-json' });
  }
}

// One CAS write: fresh ctx per attempt, day rollover first, then the op.
export async function mutate(store, base, fn) {
  const now = base.now || new Date();
  return store.apply((doc, events) => {
    const ctx = makeCtx({ ...base, now, events });
    rollover(doc, ctx);
    return fn(doc, ctx);
  });
}

// Reads roll the day over too (so the ETag changes at midnight), then return {rev, doc, ctx}.
export async function readFresh(store, base = {}) {
  const ctx = makeCtx(base);
  const { rev, doc } = await store.read();
  if (!needsRollover(doc, ctx)) return { rev, doc, ctx };
  await mutate(store, base, () => null);
  const fresh = await store.read();
  return { ...fresh, ctx };
}

// Wraps an agent handler: store, bearer token, scope, rate limit (writes), JSON body, idempotency.
// fn({ store, token, body, base }) -> Response | { status, body, headers }
export function agentHandler({ scope, write = false, maxBody = SMALL_BODY, body: wantsBody = write }, fn) {
  return async (request) => {
    try {
      const store = await getStore();
      const token = await resolveToken(store, request.headers.get('authorization'));
      if (!token) return json({ error: 'unauthorized' }, 401, { 'WWW-Authenticate': 'Bearer realm="board"' });
      const missing = (Array.isArray(scope) ? scope : scope ? [scope] : []).find((s) => !token.scopes.includes(s));
      if (missing) return json({ error: 'forbidden', scope: missing }, 403);
      if (write) {
        const rl = await rateLimit(store, token);
        if (!rl.ok) return json({ error: 'rate-limited', retryAfter: rl.retryAfter }, 429, { 'Retry-After': String(rl.retryAfter) });
      }
      let body;
      let text = '';
      if (wantsBody) ({ body, text } = await readJson(request, maxBody));

      const idemKey = write ? request.headers.get('idempotency-key') : null;
      let fingerprint = null;
      if (idemKey != null) {
        if (!KEY_RE.test(idemKey)) return json({ error: 'invalid', details: [{ path: 'Idempotency-Key', message: 'must match ^[A-Za-z0-9:._-]{1,80}$' }] }, 422);
        const u = new URL(request.url);
        fingerprint = crypto.createHash('sha256').update(`${request.method} ${u.pathname}\n${text}`).digest('hex');
        // Reserve the key atomically (SET NX) before doing any work; a concurrent duplicate sees
        // the in-progress marker and gets 409 instead of writing twice.
        const marker = { fingerprint, state: 'in-progress' };
        if (!(await store.idemPut(token.id, idemKey, marker, IDEM_PENDING_TTL))) {
          const prior = await store.idemGet(token.id, idemKey);
          if (prior && prior.fingerprint !== fingerprint) return json({ error: 'idempotency-key-reused' }, 422);
          if (!prior || prior.state === 'in-progress') return json({ error: 'in-progress' }, 409, { 'Retry-After': '1' });
          return json(prior.body, prior.status, { 'Idempotent-Replayed': 'true' });
        }
      }

      const base = { actor: { agent: token.id, label: token.label }, mode: token.mode };
      let out;
      try {
        out = await fn({ store, token, body, base, request });
      } catch (e) {
        if (idemKey != null) await store.idemDel(token.id, idemKey).catch(() => {});
        throw e;
      }
      const status = out instanceof Response ? out.status : out.status;
      if (idemKey != null) {
        if (!(out instanceof Response) && status >= 200 && status < 300) {
          await store.idemSet(token.id, idemKey, { fingerprint, state: 'done', status, body: out.body }, IDEM_TTL);
        } else {
          await store.idemDel(token.id, idemKey);
        }
      }
      if (out instanceof Response) return out;
      return json(out.body, out.status, out.headers || {});
    } catch (e) {
      return errorResponse(e);
    }
  };
}

// Last path segment of the request URL (Vercel dynamic routes: api/agent/.../[id].js).
// Malformed percent-encoding is a 404, not a 500.
export function lastSegment(request) {
  const parts = new URL(request.url).pathname.split('/').filter(Boolean);
  try {
    return decodeURIComponent(parts[parts.length - 1] || '');
  } catch {
    throw new HttpError(404, { error: 'not-found' });
  }
}
