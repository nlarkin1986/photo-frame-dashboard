// iCloud Shared Album reader (public "website" albums). Protocol notes: the album token is the
// part after '#' in https://www.icloud.com/sharedalbum/#<token>. POST {streamCtag:null} to
// https://pNN-sharedstreams.icloud.com/<token>/sharedstreams/webstream; Apple usually answers
// 330 with the album's real host in X-Apple-MMe-Host (cached per token), then 200 with photos[].
// Asset URLs come from .../webasseturls ({photoGuids}) and expire (url_expiry, ~3 h).
// The token and every Apple URL stay on the server: callers only see checksums and our data.
import { createHash } from 'node:crypto';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const HEADERS = { 'Content-Type': 'text/plain', Origin: 'https://www.icloud.com', 'User-Agent': UA };
const HOST_RE = /^[a-z0-9-]+\.icloud\.com$/;
const LIST_TTL_MS = 10 * 60 * 1000;
const BATCH = 25;
// Apple can take ~40 s to answer webstream for a few hundred photos (measured); asset URLs are quick.
const STREAM_TIMEOUT_MS = 60000;
const TIMEOUT_MS = 25000;
const SHARED_TTL_S = 6 * 3600;
const EXPIRY_MARGIN_MS = 2 * 60 * 1000;

const hosts = new Map();    // token -> host
const albums = new Map();   // token -> { at, data }
const inflight = new Map(); // token -> Promise
export function _reset() { hosts.clear(); albums.clear(); inflight.clear(); }

export function tokenFrom(url) {
  const s = String(url || '').trim();
  const t = s.includes('#') ? s.slice(s.indexOf('#') + 1) : s.replace(/^.*\//, '');
  const tok = t.split(/[;?&/]/)[0];
  return /^[A-Za-z0-9_-]{8,200}$/.test(tok) ? tok : null;
}

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export function partitionHost(token) {
  const v = (c) => Math.max(0, B62.indexOf(c));
  const n = token[0] === 'A' ? v(token[1]) : v(token[1]) * 62 + v(token[2]);
  return 'p' + (n < 10 ? '0' : '') + n + '-sharedstreams.icloud.com';
}

export const hash = (s, n = 16) => createHash('sha256').update(String(s)).digest('hex').slice(0, n);

async function request(url, init, ms = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...init, signal: ctrl.signal, redirect: 'manual' }); }
  finally { clearTimeout(timer); }
}

// POST to the album's host, following Apple's 330 "use this host" answer (at most twice).
async function post(token, path, body) {
  let host = hosts.get(token) || partitionHost(token);
  for (let hop = 0; hop < 3; hop++) {
    const r = await request(`https://${host}/${token}/sharedstreams/${path}`, { method: 'POST', headers: HEADERS, body: JSON.stringify(body) }, path === 'webstream' ? STREAM_TIMEOUT_MS : TIMEOUT_MS);
    if (r.status === 330) {
      let next = r.headers.get('x-apple-mme-host');
      if (!next) { try { next = (await r.json())['X-Apple-MMe-Host']; } catch { next = null; } }
      if (!next || !HOST_RE.test(next) || next === host) throw new Error('icloud: bad redirect');
      host = next;
      hosts.set(token, host);
      continue;
    }
    if (!r.ok) throw new Error('icloud: ' + path + ' ' + r.status);
    hosts.set(token, host);
    return r.json();
  }
  throw new Error('icloud: too many redirects');
}

// Derivatives keyed by long-edge size ('342', '2048', '2049', '2622', '3117', …). Never trust the
// key names: read width/height.
function derivatives(p) {
  return Object.entries(p.derivatives || {})
    .map(([key, d]) => ({ key, checksum: d && d.checksum, w: +(d && d.width) || 0, h: +(d && d.height) || 0 }))
    .filter((d) => d.checksum && d.w > 0 && d.h > 0)
    .map((d) => ({ ...d, edge: Math.max(d.w, d.h) }))
    .sort((a, b) => a.edge - b.edge);
}
// The slideshow image: the largest derivative with long edge in [min, max]; if there is none
// (full-resolution sharing can offer only ~342 and ~3117), the smallest one above max; else the largest.
export function pickBySize(list, max, min = 1000) {
  const fit = list.filter((d) => d.edge <= max && d.edge >= min);
  if (fit.length) return fit[fit.length - 1];
  return list.find((d) => d.edge > max) || list[list.length - 1] || null;
}
// Smallest with long edge ≥ min (else the largest).
export function pickAtLeast(list, min) {
  return list.find((d) => d.edge >= min) || list[list.length - 1] || null;
}

function shape(stream) {
  return (stream.photos || []).filter((p) => p && p.mediaAssetType !== 'video').map((p) => {
    const ds = derivatives(p);
    const large = pickBySize(ds, 2048);
    if (!large) return null;
    const small = pickAtLeast(ds.filter((d) => d.edge <= large.edge), 480) || large;
    return {
      guid: String(p.photoGuid),
      batch: String(p.batchGuid || p.photoGuid),
      w: +p.width || large.w, h: +p.height || large.h,
      created: p.dateCreated || p.batchDateCreated || null,
      caption: typeof p.caption === 'string' ? p.caption : '',
      large, small,
    };
  }).filter(Boolean);
}

async function assetUrls(token, guids) {
  const out = {};
  for (let i = 0; i < guids.length; i += BATCH) {
    const j = await post(token, 'webasseturls', { photoGuids: guids.slice(i, i + BATCH) });
    for (const [checksum, it] of Object.entries((j && j.items) || {})) {
      // Only ever fetch from Apple's content hosts.
      if (!it || !it.url_path || !/^[a-z0-9.-]+\.(icloud-content\.com|icloud\.com)$/i.test(String(it.url_location || ''))) continue;
      const exp = Date.parse(it.url_expiry);
      out[checksum] = { url: 'https://' + it.url_location + it.url_path, expires: Number.isFinite(exp) ? exp : Date.now() + 55 * 60 * 1000 };
    }
  }
  return out;
}

// Cross-instance copy on Vercel (Runtime Cache), so a cold function doesn't wait ~40 s for Apple.
async function sharedCache() {
  if (process.env.VERCEL !== '1') return null;
  try { const { getCache } = await import('@vercel/functions'); return getCache(); } catch { return null; }
}
async function sharedGet(key) {
  const c = await sharedCache();
  if (!c) return null;
  try { const v = await c.get(key); return v && v.photos ? v : null; } catch { return null; }
}
async function sharedSet(key, data) {
  const c = await sharedCache();
  if (!c) return;
  try { await c.set(key, data, { ttl: SHARED_TTL_S }); } catch { /* best effort */ }
}

function refresh(token, key) {
  if (inflight.has(token)) return inflight.get(token);
  const p = (async () => {
    const cached = albums.get(token);
    try {
      const stream = await post(token, 'webstream', { streamCtag: null });
      const photos = shape(stream);
      const urls = await assetUrls(token, photos.map((x) => x.guid));
      const data = { photos, urls, at: Date.now() };
      albums.set(token, { at: data.at, data });
      await sharedSet(key, data);
      return data;
    } catch (e) {
      if (cached) return { ...cached.data, stale: true };
      throw e;
    } finally {
      inflight.delete(token);
    }
  })();
  inflight.set(token, p);
  return p;
}

// -> { photos:[…], urls:{checksum:{url,expires}}, at }. Fresh for 10 minutes; after that the last
// copy is returned at once and refreshed in the background (see pendingRefresh). Concurrent
// calls share one fetch. When Apple fails, the last good album is returned (stale: true).
export async function album(albumUrl, { force = false } = {}) {
  const token = tokenFrom(albumUrl);
  if (!token) throw new Error('icloud: bad album url');
  const key = 'icloud-album:' + hash(token, 24);
  let cached = albums.get(token);
  if (!cached) {
    const shared = await sharedGet(key);
    if (shared) { cached = { at: shared.at, data: shared }; albums.set(token, cached); }
  }
  if (force || !cached) return refresh(token, key);
  if (Date.now() - cached.at >= LIST_TTL_MS) refresh(token, key).catch(() => {});
  return cached.data;
}
// The background refresh in flight for this album, if any (hand it to waitUntil).
export function pendingRefresh(albumUrl) {
  const token = tokenFrom(albumUrl);
  return token ? inflight.get(token) || null : null;
}

// A fresh, unexpired Apple URL for one derivative checksum (re-resolves on miss or expiry).
export async function assetUrl(albumUrl, checksum) {
  const token = tokenFrom(albumUrl);
  let data = await album(albumUrl);
  let photo = data.photos.find((x) => x.large.checksum === checksum || x.small.checksum === checksum);
  if (!photo) {
    data = await album(albumUrl, { force: true });
    photo = data.photos.find((x) => x.large.checksum === checksum || x.small.checksum === checksum);
    if (!photo) return null;
  }
  const u = data.urls[checksum];
  if (u && u.expires - EXPIRY_MARGIN_MS > Date.now()) return u.url;
  Object.assign(data.urls, await assetUrls(token, [photo.guid]));
  const v = data.urls[checksum];
  return v && v.expires - EXPIRY_MARGIN_MS > Date.now() ? v.url : null;
}

// YYYY-MM-DD in America/Chicago.
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' });
function chicagoDay(iso) {
  const d = new Date(iso);
  return Number.isNaN(+d) ? dayFmt.format(new Date()) : dayFmt.format(d);
}
function cleanCaption(s) {
  return String(s || '').replace(/[\u0000-\u001F\u007F​-‏‪-‮⁠-⁩﻿]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

// The slideshow's photo shape. Ids/tags are hashes; image sources are our own proxy URLs.
export function photoList(data) {
  return data.photos.map((p) => ({
    id: hash('icloud:' + p.large.checksum),
    o: p.h > p.w ? 'p' : 'l',
    date: chicagoDay(p.created),
    place: cleanCaption(p.caption),
    tag: 'b-' + hash(p.batch, 10),
    l: '/api/photo?i=' + encodeURIComponent(p.large.checksum) + '&s=l',
    s: '/api/photo?i=' + encodeURIComponent(p.large.checksum) + '&s=s',
  })).sort((a, b) => a.date.localeCompare(b.date));
}

// The derivative to fetch for a photo (keyed by its large checksum) and size ('l' | 's').
export function derivativeFor(data, checksum, size) {
  const p = data.photos.find((x) => x.large.checksum === checksum);
  if (!p) return null;
  return size === 's' ? p.small : p.large;
}
