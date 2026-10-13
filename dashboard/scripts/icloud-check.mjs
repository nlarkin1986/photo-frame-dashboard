// Checks for lib/icloud.js + api/photos.js + api/photo.js with a stubbed Apple. No network:
//   node scripts/icloud-check.mjs
import assert from 'node:assert/strict';
import sharp from 'sharp';
import exifr from 'exifr';
import { _reset, album, assetUrl, pendingRefresh, partitionHost, pickAtLeast, pickBySize, photoList, tokenFrom } from '../lib/icloud.js';
import { GET as PHOTOS } from '../api/photos.js';
import { GET as PHOTO, reencode } from '../api/photo.js';

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; } catch (e) { console.error(`FAIL ${name}\n`, e); process.exitCode = 1; }
}
for (const k of ['VERCEL', 'FRAME_KEY', 'ICLOUD_ALBUM_URL']) delete process.env[k];

const TOKEN = 'B2T5oqs3q2VPkhSabcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ012';
const ALBUM = 'https://www.icloud.com/sharedalbum/#' + TOKEN;
const REAL_HOST = 'p104-sharedstreams.icloud.com';

// A JPEG with GPS + camera EXIF, to prove the pipeline strips it.
const GPS_JPEG = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#88aacc' } })
  .jpeg()
  .withExif({ IFD0: { Make: 'Apple', Model: 'iPhone 17 Pro' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '43/1 7/1 0/1', GPSLongitudeRef: 'W', GPSLongitude: '87/1 53/1 0/1' } })
  .toBuffer();

function photo(n, extra = {}) {
  return {
    photoGuid: 'GUID-' + n, batchGuid: 'BATCH-' + (n < 3 ? 'A' : 'B'), dateCreated: '2026-10-11T03:30:00Z', caption: n === 1 ? 'Lake day' : '',
    width: '1536', height: '2048', contributorFullName: 'Secret Person',
    derivatives: {
      342: { checksum: 'thumb' + n + 'aaaaaaaa', width: '256', height: '342', fileSize: '1' },
      2049: { checksum: 'big' + n + 'bbbbbbbbbb', width: '1536', height: '2048', fileSize: '2' },
      ...(n === 2 ? { 3117: { checksum: 'huge2cccccccccc', width: '2338', height: '3117', fileSize: '9' }, 2622: { checksum: 'mid2dddddddddd', width: '1967', height: '2622', fileSize: '5' } } : {}),
    },
    ...extra,
  };
}
const STREAM = {
  streamName: 'Family', userFirstName: 'Owner',
  photos: [photo(1), photo(2), photo(3), { ...photo(4), mediaAssetType: 'video', derivatives: { '720p': { checksum: 'vid', width: '720', height: '1280' }, PosterFrame: { checksum: 'poster4aaaaaa', width: '720', height: '1280' } } }],
};

let calls;
let expiry = () => new Date(Date.now() + 3 * 3600e3).toISOString();
function stubApple({ failStream = false } = {}) {
  calls = { webstream: 0, webasseturls: 0, image: 0, hosts: [] };
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.hostname.endsWith('icloud-content.com')) {
      calls.image++;
      return new Response(GPS_JPEG, { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
    }
    calls.hosts.push(u.hostname);
    assert.equal(init.method, 'POST');
    if (u.hostname !== REAL_HOST) {
      return new Response(JSON.stringify({ 'X-Apple-MMe-Host': REAL_HOST }), { status: 330, headers: { 'X-Apple-MMe-Host': REAL_HOST } });
    }
    if (u.pathname.endsWith('/webstream')) {
      calls.webstream++;
      if (failStream) return new Response('nope', { status: 500 });
      await new Promise((r) => setTimeout(r, 20));
      return Response.json(STREAM);
    }
    if (u.pathname.endsWith('/webasseturls')) {
      calls.webasseturls++;
      const { photoGuids } = JSON.parse(init.body);
      assert.ok(photoGuids.length <= 25);
      const items = {};
      for (const g of photoGuids) {
        const p = STREAM.photos.find((x) => x.photoGuid === g);
        for (const d of Object.values(p.derivatives)) items[d.checksum] = { url_location: 'cvws.icloud-content.com', url_path: '/S/x/IMG_' + g + '.JPG?o=1', url_expiry: expiry() };
      }
      return Response.json({ items, locations: {} });
    }
    return new Response('?', { status: 404 });
  };
}
const realFetch = globalThis.fetch;

await test('token + partition host', () => {
  assert.equal(tokenFrom(ALBUM), TOKEN);
  assert.equal(tokenFrom('https://www.icloud.com/sharedalbum/#B0z5qAGN1JIFd3y;x'), 'B0z5qAGN1JIFd3y');
  assert.equal(tokenFrom('https://example.com/'), null);
  assert.match(partitionHost('B0z5qAGN1JIFd3y'), /^p\d+-sharedstreams\.icloud\.com$/);
  assert.equal(partitionHost('A1xyz'), 'p01-sharedstreams.icloud.com');
});

await test('derivative choice by size (incl. 2622 / 3117 keys)', () => {
  const ds = [342, 2048, 2622, 3117].map((e) => ({ edge: e, checksum: 'c' + e }));
  assert.equal(pickBySize(ds, 2048).edge, 2048);
  assert.equal(pickBySize([{ edge: 2622 }, { edge: 3117 }], 2048).edge, 2622);
  assert.equal(pickBySize([{ edge: 342 }, { edge: 3117 }], 2048).edge, 3117, 'never the thumbnail for the slideshow');
  assert.equal(pickBySize([{ edge: 342 }, { edge: 2731 }, { edge: 3117 }], 2048).edge, 2731);
  assert.equal(pickBySize([{ edge: 342 }], 2048).edge, 342);
  assert.equal(pickAtLeast(ds, 480).edge, 2048);
  assert.equal(pickAtLeast([{ edge: 342 }], 480).edge, 342);
});

await test('330 redirect is followed, host cached; videos skipped; 2048 chosen over 2622/3117', async () => {
  _reset(); stubApple();
  const a = await album(ALBUM);
  assert.equal(calls.hosts[0] === REAL_HOST, false);
  assert.equal(calls.hosts[1], REAL_HOST);
  assert.equal(a.photos.length, 3);
  const p2 = a.photos.find((p) => p.guid === 'GUID-2');
  assert.equal(p2.large.checksum, 'big2bbbbbbbbbb');
  assert.equal(p2.small.checksum, 'big2bbbbbbbbbb', 'no 480+ derivative below 2048 except 2048 itself');
  await album(ALBUM, { force: true });
  assert.ok(calls.hosts.slice(-2).every((h) => h === REAL_HOST), 'cached host used directly');
});

await test('10-minute cache + in-flight de-duplication', async () => {
  _reset(); stubApple();
  const [x, y] = await Promise.all([album(ALBUM), album(ALBUM)]);
  assert.equal(x, y);
  assert.equal(calls.webstream, 1);
  await album(ALBUM);
  assert.equal(calls.webstream, 1);
});

await test('after 10 min: stale copy returned at once, refreshed in the background', async () => {
  _reset(); stubApple();
  const first = await album(ALBUM);
  const realNow = Date.now;
  Date.now = () => realNow() + 11 * 60 * 1000;
  try {
    const again = await album(ALBUM);
    assert.equal(again, first, 'served without waiting');
    const bg = pendingRefresh(ALBUM);
    assert.ok(bg, 'refresh running');
    await bg;
    assert.equal(calls.webstream, 2);
    assert.equal(pendingRefresh(ALBUM), null);
  } finally { Date.now = realNow; }
});

await test('expired URL is re-resolved', async () => {
  _reset(); stubApple();
  expiry = () => new Date(Date.now() - 1000).toISOString();
  await album(ALBUM);
  const before = calls.webasseturls;
  expiry = () => new Date(Date.now() + 3 * 3600e3).toISOString();
  const url = await assetUrl(ALBUM, 'big1bbbbbbbbbb');
  assert.match(url, /^https:\/\/cvws\.icloud-content\.com\//);
  assert.equal(calls.webasseturls, before + 1);
  assert.equal(await assetUrl(ALBUM, 'big1bbbbbbbbbb'), url);
  assert.equal(calls.webasseturls, before + 1, 'fresh URL reused');
});

await test('photo list: slideshow shape, opaque ids, no Apple data', async () => {
  _reset(); stubApple();
  const list = photoList(await album(ALBUM));
  assert.equal(list.length, 3);
  const p = list.find((x) => x.place === 'Lake day');
  assert.equal(p.o, 'p');
  assert.equal(p.date, '2026-10-10', 'dateCreated in America/Chicago');
  assert.match(p.id, /^[a-f0-9]{16}$/);
  assert.equal(list.filter((x) => x.tag === p.tag).length, 2, 'same batch pairs');
  assert.match(p.l, /^\/api\/photo\?i=[A-Za-z0-9_-]+&s=l$/);
  const json = JSON.stringify(list);
  for (const bad of [TOKEN, 'icloud', 'GUID-', 'BATCH-', 'IMG_', 'Secret Person', 'Owner']) assert.equal(json.includes(bad), false, bad);
});

await test('api/photos: album list; Apple down with nothing cached → Blob path (empty here)', async () => {
  process.env.ICLOUD_ALBUM_URL = ALBUM;
  try {
    _reset(); stubApple();
    let r = await PHOTOS(new Request('http://x/api/photos'));
    const text = await r.text();
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(text).length, 3);
    assert.equal(text.includes(TOKEN), false);
    assert.equal(/icloud\.com|icloud-content/.test(text), false);
    _reset(); stubApple({ failStream: true });
    r = await PHOTOS(new Request('http://x/api/photos'));
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), []);
  } finally { delete process.env.ICLOUD_ALBUM_URL; }
});

await test('api/photos: Apple fails after a good load → last good list', async () => {
  process.env.ICLOUD_ALBUM_URL = ALBUM;
  try {
    _reset(); stubApple();
    await album(ALBUM);
    stubApple({ failStream: true });
    const a = await album(ALBUM, { force: true });
    assert.equal(a.stale, true);
    assert.equal(a.photos.length, 3);
  } finally { delete process.env.ICLOUD_ALBUM_URL; }
});

await test('api/photo: re-encoded, resized, GPS + device EXIF gone, immutable, no leaks', async () => {
  const before = await exifr.parse(GPS_JPEG, { gps: true });
  assert.ok(before && before.latitude, 'fixture really has GPS');
  process.env.ICLOUD_ALBUM_URL = ALBUM;
  try {
    _reset(); stubApple();
    const r = await PHOTO(new Request('http://x/api/photo?i=big1bbbbbbbbbb&s=l'));
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'private, max-age=31536000, immutable');
    const buf = Buffer.from(await r.arrayBuffer());
    const meta = await sharp(buf).metadata();
    assert.equal(meta.format, 'jpeg');
    assert.equal(meta.exif, undefined);
    assert.equal(meta.icc, undefined);
    assert.equal(await exifr.parse(buf, { gps: true }).catch(() => null) ?? null, null);
    assert.equal((await PHOTO(new Request('http://x/api/photo?i=unknown12345&s=l'))).status, 404);
    assert.equal((await PHOTO(new Request('http://x/api/photo?i=../etc&s=l'))).status, 400);
  } finally { delete process.env.ICLOUD_ALBUM_URL; }
  const big = await sharp({ create: { width: 3000, height: 4000, channels: 3, background: '#fff' } }).jpeg().toBuffer();
  const l = await sharp(await reencode(big, 'l')).metadata(), s = await sharp(await reencode(big, 's')).metadata();
  assert.equal(Math.max(l.width, l.height), 1600);
  assert.equal(Math.max(s.width, s.height), 480);
});

await test('frame-key gate', async () => {
  process.env.FRAME_KEY = 'k';
  try {
    assert.equal((await PHOTOS(new Request('http://x/api/photos'))).status, 401);
    assert.equal((await PHOTO(new Request('http://x/api/photo?i=big1bbbbbbbbbb'))).status, 401);
  } finally { delete process.env.FRAME_KEY; }
});

globalThis.fetch = realFetch;
console.log(process.exitCode ? 'icloud-check: FAILED' : `icloud-check: all ${passed} passed`);
