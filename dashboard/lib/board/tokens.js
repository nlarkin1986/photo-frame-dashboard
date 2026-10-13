// Agent bearer tokens: `fb_` + 32 random bytes (base64url). Only the SHA-256 is stored, with
// { id, label, scopes, mode, createdAt, revokedAt, lastUsedAt }. Shown once at creation.
// BOARD_DEV_TOKEN (any string) is accepted with every scope by the in-memory store only, and
// never on Vercel, so local curl testing against `npm run dev` works.
import crypto from 'node:crypto';
import { randomId } from './ops.js';

export const SCOPES = Object.freeze(['board:read', 'shopping:write', 'chores:write', 'brief:write', 'changes:read', 'private:read']);
export const MODES = Object.freeze(['direct', 'review']);
export const TOKEN_RE = /^fb_[A-Za-z0-9_-]{43}$/;
export const RATE = Object.freeze({ perMinute: 10, perHour: 120 });

export function generateToken() {
  return 'fb_' + crypto.randomBytes(32).toString('base64url');
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function parseScopes(list) {
  const scopes = [...new Set(String(list || '').split(/[\s,]+/).filter(Boolean))];
  const bad = scopes.filter((s) => !SCOPES.includes(s));
  if (bad.length) throw new Error(`unknown scope(s): ${bad.join(', ')} (valid: ${SCOPES.join(', ')})`);
  if (!scopes.length) throw new Error(`at least one scope (valid: ${SCOPES.join(', ')})`);
  return scopes;
}

export async function createToken(store, { label, scopes, mode = 'direct', now = new Date() }) {
  const cleanLabel = String(label || '').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 40);
  if (!cleanLabel) throw new Error('label is required');
  if (!MODES.includes(mode)) throw new Error(`mode must be one of ${MODES.join(', ')}`);
  const list = Array.isArray(scopes) ? parseScopes(scopes.join(',')) : parseScopes(scopes);
  const token = generateToken();
  const record = { id: randomId('a'), label: cleanLabel, scopes: list, mode, createdAt: now.toISOString(), revokedAt: null, lastUsedAt: null };
  await store.tokenPut(hashToken(token), record);
  return { token, record };
}

export async function listTokens(store) {
  return (await store.tokenList()).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

export async function revokeToken(store, id, now = new Date()) {
  return store.tokenUpdate(id, { revokedAt: now.toISOString() });
}

const touched = new Map();

export const DEV_TOKEN_ID = 'a_devtoken';

export function devTokenRecord() {
  return { id: DEV_TOKEN_ID, label: process.env.BOARD_DEV_LABEL || 'Dev agent', scopes: [...SCOPES], mode: process.env.BOARD_DEV_MODE === 'review' ? 'review' : 'direct', createdAt: null, revokedAt: null, lastUsedAt: null, dev: true };
}

// Bearer header -> active token record, or null (missing, unknown or revoked).
export async function resolveToken(store, authorization, now = new Date()) {
  // "Bearer <token>" or the bare token (some MCP clients, e.g. xAI's `authorization` field, may send it raw).
  const m = /^\s*(?:Bearer\s+)?(\S+)\s*$/i.exec(authorization || '');
  if (!m) return null;
  const token = m[1];
  const dev = process.env.BOARD_DEV_TOKEN;
  if (dev && store.kind === 'memory' && process.env.VERCEL !== '1' && safeEqual(token, dev)) return devTokenRecord();
  if (!TOKEN_RE.test(token)) return null;
  const sha = hashToken(token);
  const rec = await store.tokenGet(sha);
  if (!rec || rec.revokedAt) return null;
  // lastUsedAt at most once a minute per instance, in its own key (never rewrites the record,
  // so it cannot race with a revoke).
  const last = touched.get(rec.id) || 0;
  if (now.getTime() - last > 60000) {
    touched.set(rec.id, now.getTime());
    try { await store.tokenTouch(rec.id, now.toISOString()); } catch { /* best effort */ }
  }
  return rec;
}

// Fixed windows: 10 writes/min and 120/hour per token.
export async function rateLimit(store, rec, now = Date.now()) {
  const r = await store.rateHit(rec.id, now);
  if (r.minute > RATE.perMinute) return { ok: false, retryAfter: Math.max(1, Math.ceil((r.resetMinute - now) / 1000)) };
  if (r.hour > RATE.perHour) return { ok: false, retryAfter: Math.max(1, Math.ceil((r.resetHour - now) / 1000)) };
  return { ok: true };
}
