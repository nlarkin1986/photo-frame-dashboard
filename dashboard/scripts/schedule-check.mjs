// Checks for the schedule data layer. Plain node, no deps:  node scripts/schedule-check.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import vm from 'node:vm';
import { isWeek, mondayISO, rewritePhotos } from '../lib/dhc.js';
import { buildFixture, resetFixture } from '../lib/schedule-fixture.js';
import { GET, POST } from '../api/schedule.js';
import { GET as PHOTO } from '../api/schedule-photo.js';

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
  } catch (e) {
    console.error(`FAIL ${name}\n`, e);
    process.exitCode = 1;
  }
}
const ENV = ['DHC_ORIGIN', 'DHC_DISPLAY_TOKEN', 'VERCEL', 'FRAME_KEY'];
function env(vars) {
  for (const k of ENV) delete process.env[k];
  Object.assign(process.env, vars);
}
env({});

// ------------------------------------------------------------ rewritePhotos
await test('rewritePhotos', () => {
  const icons = { star: '<path d="M1 1"/>' };
  const pictures = [{ name: 'star', label: 'Star', category: 'Special', photo: { id: 'x', v: 1 } }];
  const input = {
    v: 1, week: '2026-10-12', icons, pictures,
    kids: [
      {
        id: 'k1', name: 'Lilly', avatar: { feeling: 'happy' },
        library: [{ photo: { id: 'p1', v: 17 }, label: 'Park' }],
        days: [{ date: '2026-10-12', sections: [{ key: 'morning', cards: [
          { id: 'c1', icon: 'sunrise', photo: null, label: 'Wake', travel: null },
          { id: 'c2', icon: null, photo: { id: 'a b&c', v: 5 }, label: 'Pic', travel: { choice: 'car' } },
        ] }] }],
      },
      { id: 'k2', name: 'Max', avatar: { photo: { id: 'av1', v: 9 } }, days: [] },
    ],
  };
  const before = JSON.stringify(input);
  const out = rewritePhotos(input);
  assert.equal(JSON.stringify(input), before, 'input not mutated');
  const [k1, k2] = out.kids;
  assert.equal(k1.avatar.src, '/api/schedule-photo?feeling=happy');
  assert.equal(k1.avatar.feeling, 'happy');
  assert.equal(k2.avatar.src, '/api/schedule-photo?id=av1&v=9');
  assert.deepEqual(k2.avatar.photo, { id: 'av1', v: 9 });
  assert.equal(k1.library[0].src, '/api/schedule-photo?id=p1&v=17');
  assert.equal(k1.library[0].label, 'Park');
  const [c1, c2] = k1.days[0].sections[0].cards;
  assert.equal(c1.src, undefined);
  assert.equal(c1.photo, null);
  assert.equal(c1.icon, 'sunrise');
  assert.equal(c2.src, '/api/schedule-photo?id=a%20b%26c&v=5');
  assert.deepEqual(c2.travel, { choice: 'car' });
  assert.equal(out.icons, icons, 'icons untouched');
  assert.equal(out.pictures, pictures, 'pictures untouched');
  assert.equal(out.pictures[0].src, undefined);
  assert.equal(rewritePhotos(null), null);
});

await test('fixture survives rewritePhotos', () => {
  const d = rewritePhotos(buildFixture('2026-10-12', new Date(2026, 9, 13, 14, 0)));
  assert.equal(d.planned, true);
  assert.deepEqual(d.can, { tick: true, edit: true });
  assert.ok(Object.keys(d.icons).length >= 20);
  assert.equal(d.pictures.length, Object.keys(d.icons).length);
  for (const p of d.pictures) assert.ok(d.icons[p.name] && p.label && p.category, p.name);
  assert.equal(d.kids.length, 2);
  assert.ok(d.kids[1].avatar.src.startsWith('/api/schedule-photo?id='));
  assert.ok(d.kids.every((k) => k.days.length === 7 && k.library.every((l) => l.src)));
  assert.ok(!d.kids[1].days[0].sections.some((s) => s.key === 'midday'), 'hidden section dropped');
  const cards = d.kids.flatMap((k) => k.days.flatMap((x) => x.sections.flatMap((s) => s.cards)));
  assert.ok(cards.some((c) => c.src) && cards.some((c) => c.icon && !c.src));
  assert.ok(cards.every((c) => !c.icon || d.icons[c.icon]), 'every used icon has markup');
  assert.ok(cards.some((c) => c.done) && cards.some((c) => !c.done));
  assert.equal(new Set(cards.map((c) => c.id)).size, cards.length, 'card ids unique');
  // Tuesday 14:00: Monday all done, Tuesday morning+midday done, evening not.
  const lilly = d.kids[0];
  assert.ok(lilly.days[0].sections.every((s) => s.cards.every((c) => c.done)));
  assert.ok(lilly.days[1].sections[0].cards.every((c) => c.done));
  assert.ok(lilly.days[1].sections[3].cards.every((c) => !c.done));
  assert.equal(buildFixture('2026-10-19', new Date(2026, 9, 13)).planned, false);
});

// ------------------------------------------------------------ week helpers (server)
await test('isWeek / mondayISO', () => {
  assert.ok(isWeek('2026-10-12'));
  for (const bad of ['2026-10-1', '2026-13-01', '2026-02-30', '26-10-12', '2026-10-12x', '', null, undefined]) assert.ok(!isWeek(bad), String(bad));
  assert.equal(mondayISO(new Date(2026, 9, 12)), '2026-10-12'); // Monday
  assert.equal(mondayISO(new Date(2026, 9, 18, 23, 59)), '2026-10-12'); // Sunday night
  assert.equal(mondayISO(new Date(2026, 9, 19, 0, 1)), '2026-10-19');
  assert.equal(mondayISO(new Date(2027, 0, 1)), '2026-12-28'); // across a year
  assert.equal(mondayISO(new Date(2026, 2, 1)), '2026-02-23'); // across a month
});

// ------------------------------------------------------------ browser module (js/schedule-data.js)
function browser({ fetch, now = new Date(2026, 9, 13, 9, 0) } = {}) {
  const handlers = {};
  const toasts = [];
  const App = {
    current: 'home',
    now: () => new Date(now),
    on: (e, fn) => (handlers[e] = handlers[e] || []).push(fn),
    emit: (e, a) => (handlers[e] || []).forEach((fn) => fn(a)),
    esc: (s) => String(s),
    toast: (msg, opts) => toasts.push({ msg, opts: opts || {} }),
  };
  const events = [];
  App.on('schedule', (d) => events.push(['schedule', d]));
  App.on('schedule-tick', (t) => events.push(['tick', t]));
  const ctx = { window: { App }, fetch, setTimeout, clearTimeout, setInterval: () => 0, AbortController, Promise, Date, JSON };
  vm.runInNewContext(fs.readFileSync(new URL('../js/schedule-data.js', import.meta.url), 'utf8'), ctx);
  return { App, S: App.schedule, toasts, events, setNow: (d) => { now = d; } };
}
// Objects from the vm realm have other prototypes; compare their JSON.
const plain = (x) => JSON.parse(JSON.stringify(x));
function res(status, body, headers = {}) {
  return Promise.resolve(new Response(body == null ? null : JSON.stringify(body), { status, headers }));
}

await test('mondayOf / todayIndex / currentSection', () => {
  const { S } = browser();
  assert.equal(S.mondayOf(new Date(2026, 9, 18)), '2026-10-12');
  assert.equal(S.mondayOf(new Date(2026, 9, 12, 0, 0)), '2026-10-12');
  assert.equal(S.mondayOf(new Date(2027, 0, 3)), '2026-12-28');
  assert.equal(S.mondayOf(), '2026-10-12');
  assert.equal(S.todayIndex(new Date(2026, 9, 12)), 0);
  assert.equal(S.todayIndex(new Date(2026, 9, 18)), 6);
  assert.equal(S.todayIndex(), 1);
  const at = (h, m) => S.currentSection(new Date(2026, 9, 13, h, m));
  assert.equal(at(0, 0), 'morning');
  assert.equal(at(10, 59), 'morning');
  assert.equal(at(11, 0), 'midday');
  assert.equal(at(12, 59), 'midday');
  assert.equal(at(13, 0), 'afternoon');
  assert.equal(at(16, 59), 'afternoon');
  assert.equal(at(17, 0), 'evening');
  assert.equal(at(19, 29), 'evening');
  assert.equal(at(19, 30), 'bedtime');
  assert.equal(at(23, 59), 'bedtime');
  assert.equal(S.currentSection(), 'morning');
});

const sample = () => rewritePhotos(buildFixture('2026-10-12', new Date(2026, 9, 13, 9, 0)));

await test('load: 200 then 304 with ETag, errors emit once', async () => {
  const calls = [];
  let next = () => res(200, sample(), { ETag: '"e1"' });
  const b = browser({ fetch: (url, init) => { calls.push({ url, init }); return next(); } });
  await b.S.load();
  assert.equal(calls[0].url, '/api/schedule?week=2026-10-12');
  assert.equal(calls[0].init.credentials, 'same-origin');
  assert.equal(b.S.data.week, '2026-10-12');
  assert.equal(b.events.length, 1);
  next = () => res(304, null);
  await b.S.load();
  assert.equal(calls[1].init.headers['If-None-Match'], '"e1"');
  assert.equal(b.events.length, 1, '304 is a no-op');
  next = () => Promise.reject(new TypeError('net'));
  await b.S.load();
  await b.S.load();
  assert.equal(b.S.error, 'offline');
  assert.ok(b.S.data, 'offline keeps stale data');
  assert.equal(b.events.length, 2, 'error emitted once');
  next = () => res(401, { error: 'unlinked' });
  await b.S.load();
  assert.equal(b.S.error, 'unlinked');
  assert.equal(b.S.data, null);
  next = () => res(503, { error: 'not-linked' });
  await b.S.load();
  assert.equal(b.S.error, 'not-linked');
  await b.S.load('2026-10-19');
  assert.equal(calls.at(-1).url, '/api/schedule?week=2026-10-19');
});

await test('poll cadence, editing pause, Monday rollover', async () => {
  const calls = [];
  const b = browser({ fetch: (url) => { calls.push(url); return res(200, sample(), { ETag: '"e"' }); } });
  await b.App.loadSchedule();
  assert.equal(calls.length, 1);
  await b.S.poll();
  assert.equal(calls.length, 1, 'not due yet');
  b.S.editing = true;
  b.setNow(new Date(2026, 9, 19, 9, 0));
  await b.S.poll();
  assert.equal(calls.length, 1, 'paused while editing');
  b.S.editing = false;
  await b.S.poll();
  assert.equal(calls.at(-1), '/api/schedule?week=2026-10-19', 'new Monday loads at once');
});

await test('tick: optimistic, undo toast, replace on 200, rollback on failure', async () => {
  let post = null;
  let next = () => res(200, sample(), { ETag: '"e"' });
  const b = browser({ fetch: (url, init) => { if (init.method === 'POST') post = init; return next(); } });
  await b.S.load();
  const card = b.S.data.kids[0].days[1].sections[3].cards[0]; // Tuesday evening: not done
  assert.equal(card.done, false);

  const saved = sample();
  saved.kids[0].days[1].sections[3].cards[0].done = true;
  next = () => res(200, saved);
  const p = b.S.tick('k1', card.id);
  assert.equal(b.S.findCard('k1', card.id).done, true, 'optimistic');
  assert.deepEqual(plain(b.events.at(-1)), ['tick', { kid: 'k1', card: card.id, done: true }]);
  assert.ok(b.toasts.at(-1).opts.undo, 'undo toast');
  assert.equal(await p, true);
  assert.equal(post.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(post.body), { week: '2026-10-12', ops: [{ op: 'tick', kid: 'k1', card: card.id, on: true }] });
  assert.equal(b.events.filter((e) => e[0] === 'schedule').length, 1, 'no rebuild when the server agrees');
  assert.equal(b.S.findCard('k1', card.id).done, true);

  // System A's own POST shape is {display}; it must count as saved, not roll back.
  const wrapped = sample();
  next = () => res(200, { display: wrapped });
  assert.equal(await b.S.tick('k1', card.id, false), true, '{display} accepted');
  assert.equal(b.S.findCard('k1', card.id).done, false);
  next = () => res(200, { display: saved });
  assert.equal(await b.S.tick('k1', card.id, true), true);

  next = () => res(500, { error: 'upstream' });
  const ok = await b.S.tick('k1', card.id, false);
  assert.equal(ok, false);
  assert.equal(b.S.findCard('k1', card.id).done, true, 'rolled back');
  assert.match(b.toasts.at(-1).msg, /Couldn.t save/);
  assert.equal(b.toasts.at(-1).opts.icon, 'bolt');

  let reloaded = 0;
  const b2 = browser({ fetch: (url, init) => {
    if (init.method === 'POST') return res(409, { error: 'gone' });
    reloaded++;
    return res(200, sample(), { ETag: '"e' + reloaded + '"' });
  } });
  await b2.S.load();
  const c2 = b2.S.data.kids[0].days[1].sections[3].cards[0];
  assert.equal(await b2.S.tick('k1', c2.id, true), false);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(reloaded, 2, '409 reloads');
  assert.match(b2.toasts.at(-1).msg, /changed/);
  assert.equal(b2.S.findCard('k1', c2.id).done, false, 'reloaded data wins');
});

await test('patch: pending, message + undo', async () => {
  let next = () => res(200, sample(), { ETag: '"e"' });
  const b = browser({ fetch: () => next() });
  await b.S.load();
  const after = sample();
  after.kids[0].days[1].sections[0].cards.pop();
  next = () => res(200, after);
  const p = b.S.patch([{ op: 'remove', kid: 'k1', card: 'x' }], { message: 'Removed', undoOps: [{ op: 'add' }] });
  assert.equal(b.S.pending, 1);
  assert.equal(await p, true);
  assert.equal(b.S.pending, 0);
  assert.deepEqual(plain(b.S.data), after);
  assert.equal(b.toasts.at(-1).msg, 'Removed');
  assert.ok(b.toasts.at(-1).opts.undo);
});

// ------------------------------------------------------------ api/schedule.js (fixture mode)
const ORIGIN = 'http://frame.test';
function post(body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Request(ORIGIN + '/api/schedule', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...headers },
    body: text,
  });
}
const week = mondayISO(new Date());

await test('POST validation', async () => {
  env({});
  resetFixture();
  const d = rewritePhotos(buildFixture(week));
  const card = d.kids[0].days[0].sections[0].cards[0];
  const tick = { week, ops: [{ op: 'tick', kid: 'k1', card: card.id, on: !card.done }] };

  assert.equal((await POST(post(tick, { Origin: 'http://evil.test' }))).status, 403, 'foreign Origin');
  assert.equal((await POST(post(tick, { Origin: 'http://evil.test', 'Sec-Fetch-Site': 'cross-site' }))).status, 403);
  const noOrigin = post(tick);
  noOrigin.headers.delete('origin');
  assert.equal((await POST(noOrigin)).status, 403, 'no Origin, no Sec-Fetch-Site');
  assert.equal((await POST(post(tick, { 'Content-Type': 'text/plain' }))).status, 415);
  assert.equal((await POST(post({ week, ops: [{ op: 'tick', pad: 'x'.repeat(17000) }] }))).status, 413);
  assert.equal((await POST(post('{nope'))).status, 400);
  assert.equal((await POST(post({ week: '2026-1-1', ops: tick.ops }))).status, 400);
  assert.equal((await POST(post({ week, ops: [] }))).status, 400);
  assert.equal((await POST(post({ week, ops: ['x'] }))).status, 400);
  const many = Array.from({ length: 21 }, () => tick.ops[0]);
  const r21 = await POST(post({ week, ops: many }));
  assert.equal(r21.status, 400);
  assert.equal((await r21.json()).error, 'too-many-ops');

  const okSfs = post(tick, { 'Content-Type': 'application/json; charset=utf-8', 'Sec-Fetch-Site': 'same-origin' });
  okSfs.headers.delete('origin');
  const r = await POST(okSfs);
  assert.equal(r.status, 200, 'Sec-Fetch-Site same-origin is enough');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const body = await r.json();
  const after = body.kids[0].days[0].sections[0].cards[0];
  assert.equal(after.done, !card.done, 'tick applied');
  assert.ok(body.kids[1].avatar.src, 'POST response rewritten');

  const r20 = await POST(post({ week, ops: Array.from({ length: 20 }, () => tick.ops[0]) }));
  assert.equal(r20.status, 200, '20 ops allowed');
  const gone = await POST(post({ week, ops: [{ op: 'tick', kid: 'k1', card: 'nope', on: true }] }));
  assert.equal(gone.status, 409);
});

await test('fixture edit ops', async () => {
  env({});
  resetFixture();
  const add = { op: 'add', kid: 'k1', day: 0, section: 'evening', index: 0, card: { id: 'abcd1234', picture: { kind: 'icon', icon: 'star' }, label: 'New', time: '', length: '', travel: null } };
  let b = await (await POST(post({ week, ops: [add, add] }))).json();
  let ev = b.kids[0].days[0].sections.find((s) => s.key === 'evening').cards;
  assert.equal(ev[0].id, 'abcd1234');
  assert.equal(ev.filter((c) => c.id === 'abcd1234').length, 1, 'add idempotent');
  b = await (await POST(post({ week, ops: [
    { op: 'update', kid: 'k1', card: 'abcd1234', set: { label: 'Renamed', picture: { kind: 'photo', photo: 'fx-lilly-park' } } },
    { op: 'move', kid: 'k1', card: 'abcd1234', toDay: 1, toSection: 'bedtime', index: 99 },
  ] }))).json();
  const bed = b.kids[0].days[1].sections.find((s) => s.key === 'bedtime').cards;
  const moved = bed.at(-1);
  assert.equal(moved.label, 'Renamed');
  assert.equal(moved.src, '/api/schedule-photo?id=fx-lilly-park&v=1');
  b = await (await POST(post({ week, ops: [{ op: 'remove', kid: 'k1', card: 'abcd1234' }, { op: 'clearDayTicks', kid: 'k1', day: 0 }] }))).json();
  assert.ok(!JSON.stringify(b).includes('abcd1234'));
  assert.ok(b.kids[0].days[0].sections.every((s) => s.cards.every((c) => !c.done)));
  const fullOps = Array.from({ length: 13 }, (_, i) => ({ ...add, card: { ...add.card, id: 'full' + i } })).slice(0, 13);
  const full = await POST(post({ week, ops: fullOps }));
  assert.equal(full.status, 409);
  assert.equal((await full.json()).error, 'full');
});

await test('GET fixture: ETag + 304, bad week', async () => {
  env({});
  resetFixture();
  const r = await GET(new Request(`${ORIGIN}/api/schedule?week=${week}`));
  assert.equal(r.status, 200);
  const tag = r.headers.get('etag');
  assert.ok(tag);
  const r2 = await GET(new Request(`${ORIGIN}/api/schedule?week=${week}`, { headers: { 'If-None-Match': tag } }));
  assert.equal(r2.status, 304);
  assert.equal((await GET(new Request(`${ORIGIN}/api/schedule?week=2026-10-1`))).status, 400);
  assert.equal((await GET(new Request(`${ORIGIN}/api/schedule?week=x`))).status, 400);
});

// ------------------------------------------------------------ api/schedule.js against a fake System A
await test('GET/POST proxy to System A', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, inm: req.headers['if-none-match'], body });
      if (req.url.startsWith('/api/display/photo')) {
        res.writeHead(200, { 'Content-Type': 'image/jpeg' });
        return res.end(Buffer.from([0xff, 0xd8, 0xff]));
      }
      if (req.headers['if-none-match'] === '"v1"') { res.writeHead(304, { ETag: '"v1"' }); return res.end(); }
      if (req.url.includes('week=2026-01-05')) { res.writeHead(401); return res.end(); }
      if (req.method === 'POST' && JSON.parse(body).ops[0].op === 'gone') {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        return res.end('{"error":"gone"}');
      }
      res.writeHead(200, { 'Content-Type': 'application/json', ETag: '"v1"' });
      const display = buildFixture('2026-10-12', new Date(2026, 9, 13));
      // Like System A: GET answers the display, POST answers {display}.
      res.end(JSON.stringify(req.method === 'POST' ? { display } : display));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    env({ DHC_ORIGIN: `http://127.0.0.1:${port}/`, DHC_DISPLAY_TOKEN: 'dhcf_test' });
    const r = await GET(new Request(`${ORIGIN}/api/schedule?week=2026-10-12`));
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('etag'), '"v1"');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.ok((await r.json()).kids[1].avatar.src);
    assert.equal(seen[0].url, '/api/display/schedule?week=2026-10-12');
    assert.equal(seen[0].auth, 'Bearer dhcf_test');

    const r304 = await GET(new Request(`${ORIGIN}/api/schedule?week=2026-10-12`, { headers: { 'If-None-Match': '"v1"' } }));
    assert.equal(r304.status, 304);
    assert.equal(r304.headers.get('etag'), '"v1"');

    const r401 = await GET(new Request(`${ORIGIN}/api/schedule?week=2026-01-05`));
    assert.equal(r401.status, 401);
    assert.deepEqual(await r401.json(), { error: 'unlinked' });

    const p = await POST(post({ week: '2026-10-12', ops: [{ op: 'tick', kid: 'k1', card: 'c', on: true }] }));
    assert.equal(p.status, 200);
    const pb = await p.json();
    assert.ok(pb.kids && !pb.display, 'POST {display} unwrapped to the display');
    assert.ok(pb.kids[1].avatar.src, 'unwrapped POST display rewritten');
    assert.deepEqual(JSON.parse(seen.at(-1).body), { week: '2026-10-12', ops: [{ op: 'tick', kid: 'k1', card: 'c', on: true }] });
    const p409 = await POST(post({ week: '2026-10-12', ops: [{ op: 'gone' }] }));
    assert.equal(p409.status, 409);
    assert.deepEqual(await p409.json(), { error: 'gone' });

    const img = await PHOTO(new Request(`${ORIGIN}/api/schedule-photo?id=abc123&v=17`));
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('cache-control'), 'private, max-age=31536000, immutable');
    assert.equal(seen.at(-1).url, '/api/display/photo?id=abc123&w=320');
    await PHOTO(new Request(`${ORIGIN}/api/schedule-photo?feeling=happy`));
    assert.equal(seen.at(-1).url, '/api/display/photo?feeling=happy');
    for (const q of ['id=abc', 'v=1', 'id=a/b&v=1', 'id=abc&v=1x', 'feeling=Happy', 'feeling=happy&id=a&v=1', 'feeling=../x', '']) {
      assert.equal((await PHOTO(new Request(`${ORIGIN}/api/schedule-photo?${q}`))).status, 400, q);
    }
  } finally {
    server.close();
  }

  // Network failure -> 502 (port now closed).
  const down = await GET(new Request(`${ORIGIN}/api/schedule`));
  assert.equal(down.status, 502);
  assert.deepEqual(await down.json(), { error: 'unreachable' });
});

await test('not linked on Vercel -> 503; frame key enforced', async () => {
  env({ VERCEL: '1', FRAME_KEY: 'secret' });
  assert.equal((await GET(new Request(`${ORIGIN}/api/schedule`))).status, 401);
  const r = await GET(new Request(`${ORIGIN}/api/schedule?key=secret`));
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), { error: 'not-linked' });
  const p = await POST(post({ week, ops: [{ op: 'tick' }] }, { Cookie: 'frame_key=secret' }));
  assert.equal(p.status, 503);
  assert.equal((await PHOTO(new Request(`${ORIGIN}/api/schedule-photo?feeling=happy&key=secret`))).status, 503);
  env({});
});

console.log(process.exitCode ? `schedule-check: failures (${passed} passed)` : `schedule-check: all ${passed} passed`);
