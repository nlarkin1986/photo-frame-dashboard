// The frame's photo list. With ICLOUD_ALBUM_URL set: the iCloud Shared Album (lib/icloud.js), in
// the slideshow's shape, with opaque ids and our own /api/photo URLs (never Apple URLs or the
// token). Otherwise (or when Apple fails with nothing cached): the list written by
// scripts/sync-photos.mjs to Blob. An empty list makes the frame keep its sample photos.
import { get } from '@vercel/blob';
import { isAuthorized, unauthorized } from '../lib/frame-key.js';
import { waitUntil } from '@vercel/functions';
import { album, pendingRefresh, photoList } from '../lib/icloud.js';

const BUDGET_MS = 8000;

async function blobList() {
  try {
    const index = await get('photos/index.json', { access: 'private', useCache: false });
    if (!index || index.statusCode !== 200) return null;
    return new Response(index.stream, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  } catch {
    return null;
  }
}

function keepAlive(p) {
  try { waitUntil(p.catch(() => {})); } catch { /* not on Vercel */ }
}

export async function GET(request) {
  if (!isAuthorized(request)) return unauthorized();
  const albumUrl = process.env.ICLOUD_ALBUM_URL;
  if (albumUrl) {
    // Apple can be slow on a cold start: wait a little, then answer with the fallback and let the
    // fetch finish in the background (the frame asks again later).
    const work = album(albumUrl);
    const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), BUDGET_MS));
    try {
      const data = await Promise.race([work, timeout]);
      if (data !== 'timeout') {
        const list = photoList(data);
        const bg = pendingRefresh(albumUrl);
        if (bg) keepAlive(bg);
        if (list.length) return Response.json(list, { headers: { 'Cache-Control': 'private, max-age=300', 'X-Photo-Source': 'album' } });
      } else {
        keepAlive(work);
      }
    } catch {
      // fall through to Blob
    }
  }
  return (await blobList()) || Response.json([], { headers: { 'Cache-Control': 'no-store' } });
}
