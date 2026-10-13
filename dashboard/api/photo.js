// One photo. `?i=<checksum>&s=l|s`: an iCloud Shared Album image, fetched from Apple server-side
// and re-encoded with sharp (upright, ≤1600 / ≤480 px long edge, JPEG q80, ALL metadata dropped:
// no GPS, no device model). `?id=<hash>&s=l|s`: the private Blob store (scripts/sync-photos.mjs).
// Both are content-addressed, so responses never change.
import { get } from '@vercel/blob';
import sharp from 'sharp';
import { isAuthorized, unauthorized } from '../lib/frame-key.js';
import { waitUntil } from '@vercel/functions';
import { album, assetUrl, derivativeFor, pendingRefresh } from '../lib/icloud.js';

const EDGE = { l: 1600, s: 480 };
const IMMUTABLE = { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=31536000, immutable' };

// Re-encode: honour EXIF orientation, resize, JPEG. sharp writes no metadata unless asked to.
export function reencode(buf, size) {
  const edge = EDGE[size] || EDGE.l;
  return sharp(buf, { failOn: 'none' })
    .rotate()
    .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80, mozjpeg: true })
    .toBuffer();
}

async function fetchImage(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error('image ' + r.status);
    return Buffer.from(await r.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

async function icloudPhoto(checksum, size) {
  const albumUrl = process.env.ICLOUD_ALBUM_URL;
  if (!albumUrl) return new Response('Not found', { status: 404 });
  let data;
  try { data = await album(albumUrl); } catch { return new Response('Unavailable', { status: 502, headers: { 'Cache-Control': 'no-store' } }); }
  const bg = pendingRefresh(albumUrl);
  if (bg) { try { waitUntil(bg.catch(() => {})); } catch { /* not on Vercel */ } }
  const d = derivativeFor(data, checksum, size);
  if (!d) return new Response('Not found', { status: 404 });
  try {
    const url = await assetUrl(albumUrl, d.checksum);
    if (!url) return new Response('Not found', { status: 404 });
    const out = await reencode(await fetchImage(url), size);
    return new Response(out, { headers: IMMUTABLE });
  } catch {
    return new Response('Unavailable', { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
}

export async function GET(request) {
  if (!isAuthorized(request)) return unauthorized();
  const params = new URL(request.url).searchParams;
  const size = params.get('s') === 's' ? 's' : 'l';
  const i = params.get('i');
  if (i != null) {
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(i)) return new Response('Bad request', { status: 400 });
    return icloudPhoto(i, size);
  }
  const id = params.get('id') || '';
  if (!/^[a-f0-9]{16}$/.test(id)) return new Response('Bad request', { status: 400 });
  const photo = await get(`photos/${id}-${size}.jpg`, { access: 'private' });
  if (!photo || photo.statusCode !== 200) return new Response('Not found', { status: 404 });
  return new Response(photo.stream, { headers: IMMUTABLE });
}
