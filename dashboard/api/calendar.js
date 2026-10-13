// The family calendar, from Google Calendar's "Secret address in iCal format" (FAMILY_ICAL_URL,
// sensitive: never logged or returned). Fetched server-side, expanded with ical.js (RRULE, EXDATE,
// RECURRENCE-ID overrides, all-day, VTIMEZONE) for today → +14 days in America/Chicago, then
// reduced to {id, title, start, end, allDay, location, lanes}. Titles/locations go through the
// board's sensitivity rules: medical/therapy/legal/financial → "Appointment" with no location;
// emails stripped, phone numbers masked. Descriptions are only used to pick lanes, never returned.
import { createHash } from 'node:crypto';
import ICAL from 'ical.js';
import { isAuthorized, unauthorized } from '../lib/frame-key.js';
import { classify } from '../lib/board/schema.js';
import { fixtureIcs } from '../lib/calendar-fixture.js';

export const TZ = 'America/Chicago';
export const DAYS = 14;
const TTL_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 8000;
const MAX_OCCURRENCES = 3000;

let cache = null; // { at, text }
export function _resetCache() { cache = null; }

// ------------------------------------------------------------ America/Chicago time helpers
const fmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
export function zoneParts(date) {
  const p = {};
  for (const x of fmt.formatToParts(date)) p[x.type] = x.value;
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}
// Wall time in America/Chicago → UTC instant (handles DST: two passes on the offset).
export function zonedToUtc(y, m, d, h = 0, mi = 0, s = 0) {
  const guess = Date.UTC(y, m - 1, d, h, mi, s);
  let t = guess;
  for (let i = 0; i < 2; i++) {
    const p = zoneParts(new Date(t));
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
    t = guess - (asUtc - t);
  }
  return new Date(t);
}
export function todayStart(now = new Date()) {
  const p = zoneParts(now);
  return zonedToUtc(p.y, p.m, p.d);
}
function pad(n) { return (n < 10 ? '0' : '') + n; }

// America/Chicago, as a VTIMEZONE, so feeds that reference the TZID without defining it still work.
const CHICAGO_VTIMEZONE = [
  'BEGIN:VCALENDAR', 'BEGIN:VTIMEZONE', 'TZID:America/Chicago',
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:-0600', 'TZOFFSETTO:-0500', 'TZNAME:CDT', 'DTSTART:19700308T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0600', 'TZNAME:CST', 'DTSTART:19701101T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'END:STANDARD',
  'END:VTIMEZONE', 'END:VCALENDAR',
].join('\r\n');
let chicagoRegistered = false;
function registerChicago() {
  if (chicagoRegistered) return;
  const tz = new ICAL.Component(ICAL.parse(CHICAGO_VTIMEZONE)).getFirstSubcomponent('vtimezone');
  ICAL.TimezoneService.register(tz);
  chicagoRegistered = true;
}

// ICAL.Time → UTC Date. Floating times (no TZID / unknown zone) are read as America/Chicago.
function toDate(t) {
  const z = t.zone;
  const known = z && (z === ICAL.Timezone.utcTimezone || (z.tzid && z.tzid !== 'floating' && ICAL.TimezoneService.has(z.tzid)));
  if (known) return new Date(t.toUnixTime() * 1000);
  return zonedToUtc(t.year, t.month, t.day, t.hour, t.minute, t.second);
}
function dateStr(t) { return t.year + '-' + pad(t.month) + '-' + pad(t.day); }

// ------------------------------------------------------------ lanes + privacy
const LANE_RES = [
  ['nate', /\bnate\b/i],
  ['hayley', /\bhayley\b/i],
  ['lilly', /\b(lilly|lily)\b/i],
  ['daisy', /\bdaisy\b/i],
];
export function lanesFor(title, description) {
  const text = String(title || '');
  let lanes = LANE_RES.filter(([, re]) => re.test(text)).map(([id]) => id);
  if (!lanes.length && description) lanes = LANE_RES.filter(([, re]) => re.test(String(description))).map(([id]) => id);
  return lanes.length ? lanes : ['family'];
}
const EMAIL_G = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;
function stripEmails(s) { return String(s || '').replace(EMAIL_G, '').replace(/\s{2,}/g, ' ').trim(); }
function scrub(raw) {
  if (!raw) return { text: '', private: false };
  const c = classify(stripEmails(String(raw).replace(/<[^>]*>/g, ' ')));
  if (c.reject) return { text: '', private: true }; // card/account numbers: fail closed
  return { text: c.text, private: c.private };
}
export function sanitize(title, location) {
  const t = scrub(title), l = scrub(location);
  if (t.private || l.private) return { title: 'Appointment', location: null, private: true };
  return { title: (t.text || 'Busy').slice(0, 120), location: l.text ? l.text.slice(0, 120) : null, private: false };
}
function idFor(uid, start) {
  return 'c' + createHash('sha1').update(String(uid) + '|' + start).digest('hex').slice(0, 12);
}

// ------------------------------------------------------------ expansion
export function expandIcs(text, { from, to }) {
  registerChicago();
  const root = new ICAL.Component(ICAL.parse(text));
  for (const tz of root.getAllSubcomponents('vtimezone')) {
    try { ICAL.TimezoneService.register(tz); } catch { /* keep going */ }
  }
  const byUid = new Map();
  for (const vev of root.getAllSubcomponents('vevent')) {
    const uid = vev.getFirstPropertyValue('uid') || Math.random().toString(36);
    if (!byUid.has(uid)) byUid.set(uid, { master: null, exceptions: [] });
    const slot = byUid.get(uid);
    if (vev.hasProperty('recurrence-id')) slot.exceptions.push(vev);
    else slot.master = vev;
  }
  const out = [];
  function push(uid, item, startT, endT) {
    if (!startT) return;
    if (String(item.component.getFirstPropertyValue('status') || '').toUpperCase() === 'CANCELLED') return;
    const allDay = startT.isDate;
    let start, end, s, e;
    if (allDay) {
      s = dateStr(startT);
      const endDate = endT ? endT : startT.clone();
      if (!endT) endDate.day += 1;
      e = dateStr(endDate);
      start = zonedToUtc(startT.year, startT.month, startT.day);
      end = zonedToUtc(endDate.year, endDate.month, endDate.day);
      if (+end <= +start) { end = new Date(+start + 864e5); }
    } else {
      start = toDate(startT);
      end = endT ? toDate(endT) : start;
      s = start.toISOString(); e = end.toISOString();
    }
    if (!(end > from && start < to) && !(+start === +end && start >= from && start < to)) return;
    const title = item.summary || '';
    const clean = sanitize(title, item.location);
    out.push({
      id: idFor(uid, s), title: clean.title, start: s, end: e, allDay,
      location: clean.location, lanes: lanesFor(title, item.description),
    });
  }
  for (const [uid, { master, exceptions }] of byUid) {
    if (!master) { // overrides without their series in this feed: treat as single events
      for (const x of exceptions) { const ev = new ICAL.Event(x); push(uid, ev, ev.startDate, ev.endDate); }
      continue;
    }
    const ev = new ICAL.Event(master);
    for (const x of exceptions) { try { ev.relateException(new ICAL.Event(x)); } catch { /* malformed override */ } }
    if (!ev.isRecurring()) { push(uid, ev, ev.startDate, ev.endDate); continue; }
    const it = ev.iterator();
    let next, n = 0;
    // Overrides can move an occurrence later than its original slot: look a day past the window.
    const stop = +to + 864e5;
    while ((next = it.next()) && n++ < MAX_OCCURRENCES) {
      const orig = next.isDate ? zonedToUtc(next.year, next.month, next.day) : toDate(next);
      if (+orig >= stop) break;
      const det = ev.getOccurrenceDetails(next);
      push(uid, det.item, det.startDate, det.endDate);
    }
  }
  out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return out;
}

// ------------------------------------------------------------ handler
function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}
async function fetchIcs(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url.replace(/^webcal:/i, 'https:'), { signal: ctrl.signal, headers: { Accept: 'text/calendar' } });
    if (!r.ok) throw new Error('upstream ' + r.status);
    const text = await r.text();
    if (!/BEGIN:VCALENDAR/.test(text)) throw new Error('not-ics');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

export async function GET(request, { now = new Date() } = {}) {
  if (!isAuthorized(request)) return unauthorized();
  const url = process.env.FAMILY_ICAL_URL;
  const from = todayStart(now);
  // Midnight (Chicago) 14 days on; noon is used to step over any DST hour safely.
  const end = zoneParts(new Date(+from + DAYS * 864e5 + 12 * 36e5));
  const window = { from, to: zonedToUtc(end.y, end.m, end.d) };
  const meta = { tz: TZ, from: window.from.toISOString(), to: window.to.toISOString() };
  if (!url) {
    if (process.env.VERCEL === '1') return json({ error: 'not-configured' }, 503, { 'Cache-Control': 'no-store' });
    return json({ ...meta, source: 'fixture', events: expandIcs(fixtureIcs(now), window) }, 200, { 'Cache-Control': 'private, max-age=300' });
  }
  let text = null, stale = false;
  if (cache && Date.now() - cache.at < TTL_MS) text = cache.text;
  else {
    try {
      text = await fetchIcs(url);
      cache = { at: Date.now(), text };
    } catch {
      if (cache) { text = cache.text; stale = true; }
    }
  }
  if (!text) return json({ error: 'upstream-unavailable' }, 502, { 'Cache-Control': 'no-store' });
  try {
    const events = expandIcs(text, window);
    return json({ ...meta, source: 'ical', stale, events }, 200, { 'Cache-Control': stale ? 'private, max-age=60' : 'private, max-age=300' });
  } catch {
    return json({ error: 'parse-failed' }, 502, { 'Cache-Control': 'no-store' });
  }
}
