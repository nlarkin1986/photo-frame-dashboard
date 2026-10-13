// Server-to-server calls to the DHC tools display API (System A), plus the helpers the
// schedule functions share. The display token lives only here (env DHC_DISPLAY_TOKEN); the
// WebView never sees it and only ever talks to this origin.

export class DhcError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'DhcError';
    this.code = code; // 'not-linked' (env missing) | 'unreachable' (network/timeout)
  }
}

// Local dev without DHC_ORIGIN serves lib/schedule-fixture.js instead of System A.
export function useFixture() {
  return !process.env.DHC_ORIGIN && process.env.VERCEL !== '1';
}

export async function dhcFetch(path, init = {}) {
  const origin = (process.env.DHC_ORIGIN || '').replace(/\/+$/, '');
  const token = process.env.DHC_DISPLAY_TOKEN || '';
  if (!origin || !token) throw new DhcError('not-linked', 'DHC_ORIGIN or DHC_DISPLAY_TOKEN is not set');
  const headers = new Headers(init.headers || {});
  headers.set('Authorization', `Bearer ${token}`);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    return await fetch(origin + path, { ...init, headers, signal: ctrl.signal, redirect: 'manual' });
  } catch (e) {
    throw new DhcError('unreachable', e && e.name === 'AbortError' ? 'timeout' : 'network error');
  } finally {
    // Headers are in by now; a body still streaming (photos) is not cut off.
    clearTimeout(timer);
  }
}

export const WEEK_RE = /^\d{4}-\d{2}-\d{2}$/;
export function isWeek(s) {
  if (typeof s !== 'string' || !WEEK_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

// Monday (ISO date) of the week containing `date`, using local calendar fields.
export function mondayISO(date = new Date()) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  const p = (n) => (n < 10 ? '0' : '') + n;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export const PHOTO_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const PHOTO_V_RE = /^[0-9]{1,16}$/;
export const FEELING_RE = /^[a-z][a-z-]{0,31}$/;

export function photoSrc(photo) {
  return `/api/schedule-photo?id=${encodeURIComponent(photo.id)}&v=${encodeURIComponent(photo.v)}`;
}
export function feelingSrc(feeling) {
  return `/api/schedule-photo?feeling=${encodeURIComponent(feeling)}`;
}

// Pure: returns a copy of the display payload where every `{photo:{id,v}}` holder (card,
// avatar, library entry — wherever it sits) gains `src` pointing at /api/schedule-photo, and
// every feeling avatar gains `src` for its feeling picture. `photo` itself is kept so the
// editor can still reference the photo id in ops. `icons` and `pictures` are left untouched.
export function rewritePhotos(display) {
  if (!display || typeof display !== 'object') return display;
  const out = {};
  for (const [k, v] of Object.entries(display)) {
    out[k] = k === 'icons' || k === 'pictures' ? v : walk(v);
  }
  return out;
}

function walk(v) {
  if (Array.isArray(v)) return v.map(walk);
  if (!v || typeof v !== 'object') return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = walk(x);
  const p = v.photo;
  if (p && typeof p === 'object' && !Array.isArray(p) && p.id != null && p.v != null) {
    out.src = photoSrc(p);
  } else if (typeof v.feeling === 'string' && !p) {
    out.src = feelingSrc(v.feeling);
  }
  return out;
}

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}
