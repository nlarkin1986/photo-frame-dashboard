// Dev-only family calendar (ICS text) for when FAMILY_ICAL_URL is unset and not on Vercel, so the
// Home and Calendar views can be checked locally. Dates are relative to `now` (America/Chicago
// wall times via TZID). Covers: a weekly RRULE with an EXDATE and a moved occurrence, all-day and
// multi-day events, multi-person titles, a sensitive (therapy) event, and a family event.

function pad(n) { return (n < 10 ? '0' : '') + n; }
function ymd(d) { return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()); }
function add(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }

export function fixtureIcs(now = new Date()) {
  const day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const at = (n, hm) => ymd(add(day0, n)) + 'T' + hm.replace(':', '') + '00';
  const date = (n) => ymd(add(day0, n));
  const ev = (uid, lines) => ['BEGIN:VEVENT', 'UID:' + uid + '@fixture', 'DTSTAMP:20261001T000000Z', ...lines, 'END:VEVENT'];
  const tz = 'TZID=America/Chicago';
  // The weekly class starts two weeks ago, skips day+7, and today's occurrence moved an hour later.
  const weeklyStart = add(day0, -14);
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//frame//fixture//EN', 'CALSCALE:GREGORIAN',
    ...ev('school-dropoff', [`DTSTART;${tz}:${at(0, '07:50')}`, `DTEND;${tz}:${at(0, '08:10')}`, 'SUMMARY:School drop-off – Lilly + Daisy', 'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', 'LOCATION:Richards Elementary']),
    ...ev('dance', [`DTSTART;${tz}:${ymd(weeklyStart)}T160000`, `DTEND;${tz}:${ymd(weeklyStart)}T170000`, 'SUMMARY:Lilly – Fresh Coast Dance', 'RRULE:FREQ=WEEKLY', `EXDATE;${tz}:${at(7, '16:00')}`, 'LOCATION:Fresh Coast Studio']),
    ...ev('dance', [`RECURRENCE-ID;${tz}:${at(0, '16:00')}`, `DTSTART;${tz}:${at(0, '17:00')}`, `DTEND;${tz}:${at(0, '18:00')}`, 'SUMMARY:Lilly – Fresh Coast Dance (moved)', 'LOCATION:Fresh Coast Studio']),
    ...ev('nate-lunch', [`DTSTART;${tz}:${at(0, '12:00')}`, `DTEND;${tz}:${at(0, '13:00')}`, 'SUMMARY:Nate lunch with Sam', 'LOCATION:Café Rustica']),
    ...ev('therapy', [`DTSTART;${tz}:${at(0, '13:30')}`, `DTEND;${tz}:${at(0, '14:20')}`, 'SUMMARY:Hayley – therapy', 'LOCATION:Bay Psychology, 409 E Silver Spring Dr', 'DESCRIPTION:Call 414-555-0182 to reschedule']),
    ...ev('daisy-pickup', [`DTSTART;${tz}:${at(0, '15:15')}`, `DTEND;${tz}:${at(0, '15:45')}`, 'SUMMARY:Pick up Daisy (Hayley)', 'LOCATION:NSMS']),
    ...ev('dinner', [`DTSTART;${tz}:${at(0, '18:00')}`, `DTEND;${tz}:${at(0, '19:00')}`, 'SUMMARY:Family dinner at Grandma’s']),
    ...ev('bookfair', [`DTSTART;VALUE=DATE:${date(1)}`, `DTEND;VALUE=DATE:${date(3)}`, 'SUMMARY:Richards Book Fair']),
    ...ev('funrun', [`DTSTART;${tz}:${at(2, '15:00')}`, `DTEND;${tz}:${at(2, '16:00')}`, 'SUMMARY:Fun Run – Lily & Nate', 'LOCATION:Richards Elementary, front doors']),
    ...ev('garbage', [`DTSTART;VALUE=DATE:${date(2)}`, `DTEND;VALUE=DATE:${date(3)}`, 'SUMMARY:Garbage + recycling out']),
    ...ev('lantern', [`DTSTART;${tz}:${at(4, '17:00')}`, `DTEND;${tz}:${at(4, '19:00')}`, 'SUMMARY:Light the Night lantern walk – Daisy', 'LOCATION:The Playscape']),
    ...ev('party', [`DTSTART;${tz}:${at(5, '10:00')}`, `DTEND;${tz}:${at(5, '11:00')}`, 'SUMMARY:Gemma’s birthday party – Lilly', 'DESCRIPTION:RSVP to gemma.mom@example.com']),
    'END:VCALENDAR', '',
  ].join('\r\n');
}
