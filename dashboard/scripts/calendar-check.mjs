// Checks for api/calendar.js (ICS expansion, lanes, privacy, handler). No network:
//   node scripts/calendar-check.mjs
import assert from 'node:assert/strict';
import { expandIcs, GET, lanesFor, sanitize, todayStart, zonedToUtc, _resetCache } from '../api/calendar.js';
import { fixtureIcs } from '../lib/calendar-fixture.js';

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; } catch (e) { console.error(`FAIL ${name}\n`, e); process.exitCode = 1; }
}
for (const k of ['VERCEL', 'FRAME_KEY', 'FAMILY_ICAL_URL']) delete process.env[k];

const TZ = 'TZID=America/Chicago';
const VTZ = [
  'BEGIN:VTIMEZONE', 'TZID:America/Chicago',
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:-0600', 'TZOFFSETTO:-0500', 'TZNAME:CDT', 'DTSTART:19700308T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0600', 'TZNAME:CST', 'DTSTART:19701101T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'END:STANDARD',
  'END:VTIMEZONE',
];
function ics(events, withTz = true) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', ...(withTz ? VTZ : []),
    ...events.flatMap((lines) => ['BEGIN:VEVENT', 'DTSTAMP:20261001T000000Z', ...lines, 'END:VEVENT']), 'END:VCALENDAR', ''].join('\r\n');
}
// Window: Mon Oct 26 2026 00:00 CDT → Mon Nov 9 00:00 CST (crosses the Nov 1 DST change).
const from = zonedToUtc(2026, 10, 26), to = zonedToUtc(2026, 11, 9);
const W = { from, to };

const FEED = ics([
  // Weekly Tuesday 4–5 PM, skip Nov 3, move Oct 27 to Wednesday 5 PM.
  ['UID:dance@x', `DTSTART;${TZ}:20261006T160000`, `DTEND;${TZ}:20261006T170000`, 'SUMMARY:Lilly dance', 'RRULE:FREQ=WEEKLY', `EXDATE;${TZ}:20261103T160000`, 'LOCATION:Studio'],
  ['UID:dance@x', `RECURRENCE-ID;${TZ}:20261027T160000`, `DTSTART;${TZ}:20261028T170000`, `DTEND;${TZ}:20261028T180000`, 'SUMMARY:Lilly dance (moved)'],
  ['UID:allday@x', 'DTSTART;VALUE=DATE:20261030', 'DTEND;VALUE=DATE:20261031', 'SUMMARY:No school'],
  ['UID:multi@x', `DTSTART;${TZ}:20261029T090000`, `DTEND;${TZ}:20261029T100000`, 'SUMMARY:Nate + Hayley + Lily conference'],
  ['UID:therapy@x', `DTSTART;${TZ}:20261030T123000`, `DTEND;${TZ}:20261030T132000`, 'SUMMARY:Daisy therapy', 'LOCATION:Bay Psychology, 409 E Silver Spring Dr'],
  // Daily 8 AM across the DST change: local wall time must stay 8:00.
  ['UID:daily@x', `DTSTART;${TZ}:20261030T080000`, `DTEND;${TZ}:20261030T081500`, 'SUMMARY:Feed the cat', 'RRULE:FREQ=DAILY;COUNT=4'],
  ['UID:cancelled@x', `DTSTART;${TZ}:20261027T090000`, `DTEND;${TZ}:20261027T100000`, 'SUMMARY:Cancelled thing', 'STATUS:CANCELLED'],
  ['UID:phone@x', `DTSTART;${TZ}:20261102T090000`, `DTEND;${TZ}:20261102T093000`, 'SUMMARY:Call plumber 414-555-0182 bob@example.com'],
]);

await test('weekly RRULE with EXDATE and a moved occurrence', () => {
  const ev = expandIcs(FEED, W).filter((e) => /dance/.test(e.title));
  assert.deepEqual(ev.map((e) => e.start), [
    '2026-10-28T22:00:00.000Z',   // moved: Wed Oct 28 5 PM CDT
    // Nov 3 excluded
  ]);
  assert.equal(ev[0].title, 'Lilly dance (moved)');
  assert.deepEqual(ev[0].lanes, ['lilly']);
});

await test('all-day event keeps its dates', () => {
  const e = expandIcs(FEED, W).find((x) => x.title === 'No school');
  assert.equal(e.allDay, true);
  assert.equal(e.start, '2026-10-30');
  assert.equal(e.end, '2026-10-31');
  assert.deepEqual(e.lanes, ['family']);
});

await test('multi-person title → several lanes (Lily alias)', () => {
  const e = expandIcs(FEED, W).find((x) => /conference/.test(x.title));
  assert.deepEqual(e.lanes, ['nate', 'hayley', 'lilly']);
  assert.deepEqual(lanesFor('Pick up DAISY'), ['daisy']);
  assert.deepEqual(lanesFor('Natedog party'), ['family']);
  assert.deepEqual(lanesFor('Dentist', 'for Lilly'), ['lilly']);
});

await test('therapy → "Appointment", no location, lanes and time kept', () => {
  const e = expandIcs(FEED, W).find((x) => x.start === '2026-10-30T17:30:00.000Z');
  assert.equal(e.title, 'Appointment');
  assert.equal(e.location, null);
  assert.deepEqual(e.lanes, ['daisy']);
  assert.equal(sanitize('Lilly 12:30', 'Bay Psychology').title, 'Appointment');
  assert.equal(sanitize('Soccer', 'Lakeshore Fields').title, 'Soccer');
});

await test('emails stripped, phone numbers masked, cancelled skipped', () => {
  const list = expandIcs(FEED, W);
  const e = list.find((x) => /plumber/.test(x.title));
  assert.doesNotMatch(e.title, /@/);
  assert.match(e.title, /xxx-xxx-0182/);
  assert.equal(list.some((x) => /Cancelled/.test(x.title)), false);
});

await test('DST boundary: 8 AM stays 8 AM local', () => {
  const ev = expandIcs(FEED, W).filter((e) => e.title === 'Feed the cat').map((e) => e.start);
  assert.deepEqual(ev, ['2026-10-30T13:00:00.000Z', '2026-10-31T13:00:00.000Z', '2026-11-01T14:00:00.000Z', '2026-11-02T14:00:00.000Z']);
});

await test('window: start of today (Chicago) to +14 days; floating times read as Chicago', () => {
  assert.equal(todayStart(new Date('2026-11-02T03:00:00Z')).toISOString(), '2026-11-01T05:00:00.000Z'); // Nov 1 local, CDT midnight
  const floating = ics([['UID:f@x', 'DTSTART:20261027T090000', 'DTEND:20261027T100000', 'SUMMARY:Floating']], false);
  assert.equal(expandIcs(floating, W)[0].start, '2026-10-27T14:00:00.000Z');
  const before = ics([['UID:old@x', `DTSTART;${TZ}:20261020T090000`, `DTEND;${TZ}:20261020T100000`, 'SUMMARY:Old']]);
  assert.equal(expandIcs(before, W).length, 0);
});

await test('fixture feed parses', () => {
  const now = new Date();
  const s = todayStart(now);
  const list = expandIcs(fixtureIcs(now), { from: s, to: new Date(+s + 14 * 864e5) });
  assert.ok(list.length > 10);
  assert.ok(list.some((e) => e.title === 'Appointment'));
});

await test('handler: not-configured on Vercel, fixture in local dev', async () => {
  process.env.VERCEL = '1';
  process.env.FRAME_KEY = 'k';
  let r = await GET(new Request('http://x/api/calendar?key=k'));
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), { error: 'not-configured' });
  delete process.env.VERCEL; delete process.env.FRAME_KEY;
  r = await GET(new Request('http://x/api/calendar'));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).source, 'fixture');
});

await test('handler: caches 5 min, serves last good copy on failure, never leaks the URL', async () => {
  _resetCache();
  const SECRET = 'https://calendar.google.com/calendar/ical/secret-abc/private-xyz/basic.ics';
  process.env.FAMILY_ICAL_URL = SECRET.replace('https:', 'webcal:');
  const real = globalThis.fetch;
  let calls = 0, fail = false, seen = '';
  globalThis.fetch = async (url) => {
    calls++; seen = String(url);
    if (fail) throw new Error('down');
    return new Response(FEED, { status: 200, headers: { 'Content-Type': 'text/calendar' } });
  };
  try {
    const now = new Date('2026-10-26T15:00:00Z');
    let r = await GET(new Request('http://x/api/calendar'), { now });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'private, max-age=300');
    const body = await r.text();
    assert.equal(body.includes('secret-abc'), false);
    assert.equal(seen, SECRET, 'webcal: becomes https:');
    assert.ok(JSON.parse(body).events.length > 3);
    await GET(new Request('http://x/api/calendar'), { now });
    assert.equal(calls, 1, 'cached');
    // Expire the cache, then fail upstream: last good copy, marked stale.
    _resetCache();
    await GET(new Request('http://x/api/calendar'), { now });
    fail = true;
    const realNow = Date.now;
    Date.now = () => realNow() + 6 * 60 * 1000;
    try {
      r = await GET(new Request('http://x/api/calendar'), { now });
    } finally { Date.now = realNow; }
    assert.equal(r.status, 200);
    assert.equal((await r.json()).stale, true);
    _resetCache();
    r = await GET(new Request('http://x/api/calendar'), { now });
    assert.equal(r.status, 502);
    assert.equal((await r.text()).includes('secret'), false);
  } finally {
    globalThis.fetch = real;
    delete process.env.FAMILY_ICAL_URL;
  }
});

console.log(process.exitCode ? 'calendar-check: FAILED' : `calendar-check: all ${passed} passed`);
