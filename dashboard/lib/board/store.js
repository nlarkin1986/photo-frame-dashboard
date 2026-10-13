// Board storage. One JSON document (`fb:doc`) guarded by a global revision (`fb:rev`, the ETag),
// written with compare-and-set: read doc+rev, apply the op in JS, then commit only if rev is
// unchanged (a Lua script on Redis); on a lost race the op is re-applied to the fresh doc.
// Side records that are not part of the board: change log, idempotency keys, token records,
// per-token rate-limit counters.
//
// getStore() picks: on Vercel, Upstash Redis (KV_REST_API_* or UPSTASH_REDIS_REST_*), or
// NotConfiguredError (503) when unset. Outside Vercel: the in-memory store (dev + tests), unless
// BOARD_STORE=redis is set explicitly.
import { emptyDoc, OpError } from './ops.js';

export const CHANGES_MAX = 1000;

// Server-side change cursors per token (and per consumer, e.g. the shopping digest), so stateless
// agents can ask for "what changed since I last looked".
export function cursorKey(tokenId, name = '') {
  return `fb:cursor:${tokenId}${name ? ':' + name : ''}`;
}
const P = 'fb:';

export class NotConfiguredError extends Error {
  constructor() {
    super('not-configured');
    this.name = 'NotConfiguredError';
  }
}

export function redisEnv(env = process.env) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}

// Shared CAS loop. `mutator(doc, events)` mutates its copy and may throw (OpError etc.).
// A mutator that leaves the document byte-identical commits nothing (no rev bump).
async function applyWith(store, mutator, { retries = 3 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const { rev, doc } = await store.read();
    const before = JSON.stringify(doc);
    const work = JSON.parse(before);
    const events = [];
    const result = await mutator(work, events);
    if (JSON.stringify(work) === before && events.length === 0) return { rev, result, changed: false };
    const next = rev + 1;
    work.rev = next;
    const stamped = events.map((e) => ({ rev: next, ...e }));
    if (await store._cas(rev, work, stamped)) return { rev: next, result, changed: true, attempts: attempt + 1 };
  }
  throw new OpError(409, 'conflict');
}

function sinceFilter(all, since) {
  return { events: all.filter((e) => e.rev > since), oldest: all.length ? all[0].rev : null };
}

// ------------------------------------------------------------------ in-memory
export function createMemoryStore({ seed = null } = {}) {
  let rev = 0;
  let docJson = JSON.stringify(seed ? { ...seed, rev: 0 } : emptyDoc());
  let day = null;
  let changes = [];
  const tokens = new Map(); // sha -> record
  const used = new Map(); // id -> lastUsedAt
  const cursors = new Map(); // cursorKey -> rev
  const idem = new Map(); // tok:key -> { value, exp }
  const rl = new Map(); // bucket -> { n, exp }
  const store = {
    kind: 'memory',
    hooks: {}, // tests: hooks.beforeCas = async () => {...} to simulate a concurrent writer
    async read() {
      return { rev, doc: JSON.parse(docJson) };
    },
    async peek() {
      return { rev, day };
    },
    async _cas(expected, doc, events) {
      if (store.hooks.beforeCas) await store.hooks.beforeCas();
      if (rev !== expected) return false;
      rev = doc.rev;
      docJson = JSON.stringify(doc);
      day = doc.day;
      changes.push(...events);
      if (changes.length > CHANGES_MAX) changes = changes.slice(-CHANGES_MAX);
      return true;
    },
    apply(mutator, opts) {
      return applyWith(store, mutator, opts);
    },
    async changes(since) {
      return { rev, ...sinceFilter(changes, since) };
    },
    async cursorGet(tokenId, name) {
      const v = cursors.get(cursorKey(tokenId, name));
      return v == null ? null : v;
    },
    async cursorSet(tokenId, name, value) {
      cursors.set(cursorKey(tokenId, name), value);
    },
    async tokenGet(sha) {
      const r = tokens.get(sha);
      return r ? { ...r } : null;
    },
    async tokenPut(sha, rec) {
      tokens.set(sha, { ...rec });
    },
    async tokenList() {
      return [...tokens.values()].map((r) => ({ ...r, lastUsedAt: used.get(r.id) || null }));
    },
    // lastUsedAt lives apart from the record so a touch can never undo a concurrent revoke.
    async tokenTouch(id, at) {
      used.set(id, at);
    },
    async tokenUpdate(id, patch) {
      for (const [sha, r] of tokens) if (r.id === id) { tokens.set(sha, { ...r, ...patch }); return true; }
      return false;
    },
    async idemGet(tok, key) {
      const e = idem.get(`${tok}:${key}`);
      if (!e || e.exp < Date.now()) return null;
      return e.value;
    },
    async idemPut(tok, key, value, ttlSec) {
      const k = `${tok}:${key}`;
      const e = idem.get(k);
      if (e && e.exp >= Date.now()) return false;
      idem.set(k, { value, exp: Date.now() + ttlSec * 1000 });
      return true;
    },
    async idemSet(tok, key, value, ttlSec) {
      idem.set(`${tok}:${key}`, { value, exp: Date.now() + ttlSec * 1000 });
    },
    async idemDel(tok, key) {
      idem.delete(`${tok}:${key}`);
    },
    async rateHit(tok, now = Date.now()) {
      const hit = (bucket, ttl) => {
        const e = rl.get(bucket);
        if (!e || e.exp < now) { rl.set(bucket, { n: 1, exp: now + ttl }); return 1; }
        e.n += 1;
        return e.n;
      };
      const m = Math.floor(now / 60000);
      const h = Math.floor(now / 3600000);
      return { minute: hit(`${tok}:m:${m}`, 120000), hour: hit(`${tok}:h:${h}`, 7200000), resetMinute: (m + 1) * 60000, resetHour: (h + 1) * 3600000 };
    },
  };
  return store;
}

// ------------------------------------------------------------------ Upstash Redis
const CAS_LUA = `
local cur = tonumber(redis.call('GET', KEYS[1]) or '0')
if cur ~= tonumber(ARGV[1]) then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
redis.call('SET', KEYS[2], ARGV[3])
redis.call('SET', KEYS[3], ARGV[4])
for i = 5, #ARGV do redis.call('RPUSH', KEYS[4], ARGV[i]) end
redis.call('LTRIM', KEYS[4], -${CHANGES_MAX}, -1)
return 1`;

export async function createRedisStore({ url, token, client = null } = {}) {
  let redis = client;
  if (!redis) {
    const { Redis } = await import('@upstash/redis');
    redis = new Redis({ url, token, automaticDeserialization: false, enableTelemetry: false });
  }
  const parse = (s) => (s == null ? null : typeof s === 'string' ? JSON.parse(s) : s);
  const store = {
    kind: 'redis',
    async read() {
      const [r, d] = await redis.mget(P + 'rev', P + 'doc');
      const rev = Number(r || 0);
      const doc = parse(d) || emptyDoc();
      doc.rev = rev;
      return { rev, doc };
    },
    async peek() {
      const [r, day] = await redis.mget(P + 'rev', P + 'day');
      return { rev: Number(r || 0), day: day || null };
    },
    async _cas(expected, doc, events) {
      const ok = await redis.eval(CAS_LUA, [P + 'rev', P + 'doc', P + 'day', P + 'changes'], [
        String(expected), String(doc.rev), JSON.stringify(doc), doc.day || '', ...events.map((e) => JSON.stringify(e)),
      ]);
      return Number(ok) === 1;
    },
    apply(mutator, opts) {
      return applyWith(store, mutator, opts);
    },
    async changes(since) {
      const [r, list] = await Promise.all([redis.get(P + 'rev'), redis.lrange(P + 'changes', 0, -1)]);
      return { rev: Number(r || 0), ...sinceFilter(list.map(parse), since) };
    },
    async cursorGet(tokenId, name) {
      const v = await redis.get(cursorKey(tokenId, name));
      return v == null ? null : Number(v);
    },
    async cursorSet(tokenId, name, value) {
      await redis.set(cursorKey(tokenId, name), String(value), { ex: 90 * 24 * 3600 });
    },
    async tokenGet(sha) {
      return parse(await redis.get(P + 'tok:' + sha));
    },
    async tokenPut(sha, rec) {
      await redis.set(P + 'tok:' + sha, JSON.stringify(rec));
      await redis.hset(P + 'tokids', { [rec.id]: sha });
    },
    async tokenList() {
      const ids = (await redis.hgetall(P + 'tokids')) || {};
      const shas = Object.values(ids);
      if (!shas.length) return [];
      const recs = (await redis.mget(...shas.map((s) => P + 'tok:' + s))).map(parse).filter(Boolean);
      if (!recs.length) return [];
      const usedAt = await redis.mget(...recs.map((r) => P + 'tokused:' + r.id));
      return recs.map((r, i) => ({ ...r, lastUsedAt: usedAt[i] || null }));
    },
    // lastUsedAt lives in its own key so a touch can never overwrite a concurrent revoke.
    async tokenTouch(id, at) {
      await redis.set(P + 'tokused:' + id, at);
    },
    async tokenUpdate(id, patch) {
      const sha = await redis.hget(P + 'tokids', id);
      if (!sha) return false;
      const rec = parse(await redis.get(P + 'tok:' + sha));
      if (!rec) return false;
      await redis.set(P + 'tok:' + sha, JSON.stringify({ ...rec, ...patch }));
      return true;
    },
    async idemGet(tok, key) {
      return parse(await redis.get(`${P}idem:${tok}:${key}`));
    },
    async idemPut(tok, key, value, ttlSec) {
      const r = await redis.set(`${P}idem:${tok}:${key}`, JSON.stringify(value), { nx: true, ex: ttlSec });
      return r === 'OK';
    },
    async idemSet(tok, key, value, ttlSec) {
      await redis.set(`${P}idem:${tok}:${key}`, JSON.stringify(value), { ex: ttlSec });
    },
    async idemDel(tok, key) {
      await redis.del(`${P}idem:${tok}:${key}`);
    },
    async rateHit(tok, now = Date.now()) {
      const m = Math.floor(now / 60000);
      const h = Math.floor(now / 3600000);
      const km = `${P}rl:${tok}:m:${m}`;
      const kh = `${P}rl:${tok}:h:${h}`;
      const [minute, , hour] = await redis.pipeline().incr(km).expire(km, 120).incr(kh).expire(kh, 7200).exec();
      return { minute: Number(minute), hour: Number(hour), resetMinute: (m + 1) * 60000, resetHour: (h + 1) * 3600000 };
    },
  };
  return store;
}

// ------------------------------------------------------------------ selection
let current = null;

// Lazily seeds the dev store from lib/board/fixture.js (written by the frame UI work) if present.
async function devSeed() {
  try {
    const mod = await import(new URL('./fixture.js', import.meta.url).href);
    if (typeof mod.boardFixture !== 'function') return null;
    const { seedFromFixture } = await import('./seed.js');
    return seedFromFixture(mod.boardFixture(new Date()));
  } catch (e) {
    if (e && (e.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find module|Failed to load/.test(String(e.message)))) return null;
    console.warn('[board] fixture seed skipped:', e && e.message);
    return null;
  }
}

export async function getStore() {
  if (current) return current;
  // Outside Vercel the in-memory store is always used unless BOARD_STORE=redis is set explicitly,
  // so dev/tests never touch the production Redis even if KV_* ends up in .env.local.
  const onVercel = process.env.VERCEL === '1';
  const env = onVercel || process.env.BOARD_STORE === 'redis' ? redisEnv() : null;
  if (env) {
    current = createRedisStore(env);
  } else if (onVercel || process.env.BOARD_STORE === 'redis') {
    throw new NotConfiguredError();
  } else {
    current = devSeed().then((seed) => createMemoryStore({ seed }));
  }
  try {
    current = await current;
  } catch (e) {
    current = null;
    throw e;
  }
  return current;
}

// Tests: swap in a fresh store (or null to re-pick from env).
export function setStore(store) {
  current = store;
}
