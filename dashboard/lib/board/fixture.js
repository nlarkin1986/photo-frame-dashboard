// Local-dev board content in the canonical contract shape (docs/plans/board-contract.md):
// the Oct 12 weekly brief, re-dated to the week of `today`, plus a few agent-sourced shopping
// items and chores. Private items arrive the way the server sends them to the frame: text
// replaced by a generic label, owner/time kept. Phone numbers and amounts are left out.
//
//   import { boardFixture } from './fixture.js';
//   const { shopping, chores, brief } = boardFixture(new Date());

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function pad(n) { return (n < 10 ? '0' : '') + n; }
function iso(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function at(d, h, m) { const x = new Date(d); x.setHours(h, m || 0, 0, 0); return x.toISOString(); }
function mondayOf(date) {
  const d = new Date(date);
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - (x.getDay() + 6) % 7);
  return x;
}
// Server ids look like ^[a-z]_[a-z0-9]{8}$; these are stable per fixture entry.
function fid(prefix, name) { return prefix + '_' + (name + '00000000').replace(/[^a-z0-9]/g, '').slice(0, 8); }

const AGENTS = {
  week: { agent: 'fb_weekahd', label: 'Week-ahead agent' },
  grocery: { agent: 'fb_grocery', label: 'Grocery agent' },
  school: { agent: 'fb_schoolm', label: 'School-email agent' },
  chores: { agent: 'fb_choresa', label: 'Chores agent' },
  frame: { agent: 'frame', label: 'Frame' },
};
const KRISTIN = { name: 'Kristin' };
const US = { name: 'Us' };
const P = (id) => ({ person: id });

export function boardFixture(today) {
  const now = today ? new Date(today) : new Date();
  const mon = mondayOf(now);
  const day = (i) => iso(addDays(mon, i));
  const sun = addDays(mon, 6);
  const title = mon.getMonth() === sun.getMonth()
    ? MONTHS[mon.getMonth()] + ' ' + mon.getDate() + '–' + sun.getDate()
    : MONTHS[mon.getMonth()].slice(0, 3) + ' ' + mon.getDate() + ' – ' + MONTHS[sun.getMonth()].slice(0, 3) + ' ' + sun.getDate();
  const published = at(addDays(mon, -1), 9, 6);

  // ---------------------------------------------------------------- brief
  const dPickup = fid('d', 'pickup');
  const dCare = fid('d', 'care');
  const dFunRun = fid('d', 'funrun');
  let n = 0;
  const item = (o) => Object.assign({ id: fid('i', 'item' + ('000' + (++n)).slice(-4)), kind: 'timed', people: [], private: false }, o);

  const brief = {
    week: day(0),
    title,
    publishedAt: published,
    source: AGENTS.week,
    headline: [
      { id: fid('h', 'lilly'), person: 'lilly', text: 'out 10:55 daily' },
      { id: fid('h', 'daisy'), person: 'daisy', text: 'normal week' },
    ],
    days: [
      {
        date: day(0), care: { who: US, needed: true }, specials: [{ person: 'lilly', text: 'PE' }],
        items: [
          item({ kind: 'allDay', text: 'PE: Lilly wears sneakers', people: ['lilly'] }),
          item({ kind: 'note', text: 'High near 85°. Storms possible late.' }),
          item({ time: '4:00–5:00', text: 'Fresh Coast Dance (where?)', people: ['lilly'] }),
        ],
      },
      {
        date: day(1), care: { who: KRISTIN, needed: true, label: 'from 11:30' }, specials: [{ person: 'lilly', text: 'SEL · Tech · Counselor' }],
        items: [
          item({ time: '10:55', text: 'Lilly pickup', people: ['lilly'], decision: dPickup }),
          item({ kind: 'note', text: 'Kim out · pickup notes go to the office' }),
        ],
      },
      {
        date: day(2), care: { who: KRISTIN, needed: true }, specials: [{ person: 'lilly', text: 'Library · Kim back' }],
        items: [
          item({ time: '8–7', text: 'Richards Book Fair, gym', place: 'Richards' }),
          item({ time: '3:30–5', text: 'Ms. Kathie’s drop-in' }),
        ],
      },
      {
        date: day(3), care: { who: null, needed: true }, specials: [{ person: 'lilly', text: 'Music' }],
        items: [
          item({ time: '7:00 AM', text: 'Garbage out' }),
          item({ time: '3:00', text: 'Lilly back for Fun Run', people: ['lilly'], place: 'Front doors', decision: dFunRun }),
          item({ time: '3:15', text: 'K4 runs · sneakers + play clothes', place: 'Field behind school' }),
          item({ time: '10:30–7', text: 'Book Fair' }),
          item({ kind: 'allDay', text: 'Boo Bag pickup, front vestibule' }),
        ],
      },
      {
        date: day(4), care: { who: null, needed: true }, specials: [{ person: 'lilly', text: 'Art' }],
        items: [
          item({ kind: 'deadline', text: 'Pledgestar closes · enter Lilly', people: ['lilly'] }),
          // Bay Psych: private on the server; the frame only ever sees this.
          item({ time: '12:30', text: 'Private appointment', private: true }),
          item({ time: 'TBD', text: 'Music Together Rhythm Kids restarts', people: ['daisy'] }),
        ],
      },
      {
        date: day(5), care: { who: null, needed: false }, specials: [],
        items: [item({ time: '5:00–7:00', text: 'Light the Night lantern walk · warm layers', people: ['daisy'], place: 'The Playscape' })],
      },
      {
        date: day(6), care: { who: null, needed: false }, specials: [],
        items: [item({ time: '10:00–11:00', text: 'Gemma’s party · where? RSVP?', people: ['lilly'] })],
      },
    ],
    decisions: [
      {
        id: dPickup, title: 'Who picks up Lilly?', context: 'Kristin usually starts at 11:30.',
        when: { date: day(1), time: '10:55' }, kind: 'ride',
        slots: [{ id: fid('s', 'pickup'), label: 'Pickup', date: day(1), who: null }],
        candidates: [KRISTIN], done: false, private: false,
      },
      {
        id: dCare, title: 'Who has the girls?', context: 'No care is named yet.',
        when: { date: day(2) }, kind: 'care',
        slots: [
          { id: fid('s', 'carewed'), label: 'Wed', date: day(2), who: KRISTIN },
          { id: fid('s', 'carethu'), label: 'Thu', date: day(3), who: null },
          { id: fid('s', 'carefri'), label: 'Fri', date: day(4), who: null },
        ],
        candidates: [KRISTIN], done: false, private: false,
      },
      {
        id: dFunRun, title: 'Who takes Lilly to the Fun Run?', context: 'Back at school by 3:00, front doors.',
        when: { date: day(3), time: '3:00' }, kind: 'ride',
        slots: [{ id: fid('s', 'funrun'), label: 'Fun Run', date: day(3), who: null }],
        candidates: [KRISTIN], done: false, private: false,
      },
    ],
    todos: [
      { id: fid('t', 'pledge'), text: 'Enter Lilly on Pledgestar', owner: null, due: day(4), link: { host: 'richards.pledgestar.com', label: 'Pledgestar' }, done: false, private: false },
      // Chase fraud alert + Zelle request: private on the server.
      { id: fid('t', 'chase'), text: 'Private item', owner: P('hayley'), done: false, private: true },
      { id: fid('t', 'zelle'), text: 'Private item', owner: null, done: false, private: true },
      { id: fid('t', 'portrait'), text: 'Order Daisy’s school portraits', owner: P('hayley'), done: false, private: false },
      { id: fid('t', 'portal'), text: 'Set up the Fresh Coast parent portal', owner: P('nate'), done: false, private: false },
      { id: fid('t', 'confer'), text: 'Fix Daisy’s conference: ends 8:45 AM', owner: null, done: false, private: false },
    ],
    stillOpen: [
      { id: fid('o', 'vector'), text: 'Vector Training' },
      { id: fid('o', 'purdy'), text: 'Dr. Purdy' },
      { id: fid('o', 'jcc'), text: 'JCC follow-up' },
      { id: fid('o', 'nanny'), text: 'Nanny search' },
    ],
    comingUp: [
      { id: fid('u', 'rsvp'), date: day(8), text: 'RSVP Hendrix’s party · text Alley' },
      { id: fid('u', 'confer'), date: day(11), time: '8:25–8:45 AM', text: 'Daisy’s conference', place: 'Music Together' },
      { id: fid('u', 'hendrix'), date: day(12), time: '10:30–12:30', text: 'Hendrix turns 2 · Lindner Pumpkin Farm', place: 'New Berlin' },
      { id: fid('u', 'boobag'), date: day(13), text: 'Last day for Boo Bags' },
      { id: fid('u', 'jkparty'), date: day(15), time: '8:15–9:15 AM', text: 'JK Halloween party' },
      { id: fid('u', 'mthallo'), date: day(18), text: 'Music Together Halloween class · costumes OK' },
    ],
    notes: [{ id: fid('n', 'unknown'), text: 'Times for Music Together and the Fresh Coast location still unknown.' }],
  };

  // ---------------------------------------------------------------- shopping
  const added = at(addDays(now, -1), 18, 20);
  let s = 0;
  const shop = (text, o) => Object.assign({
    id: fid('g', 'item' + ('000' + (++s)).slice(-4)), text, qty: 1, store: null, category: null, note: '', suggested: false,
    done: false, doneBy: null, doneAt: null, addedBy: AGENTS.frame, addedAt: added, updatedAt: added,
  }, o || {});
  const shopping = {
    items: [
      shop('Milk 2%', { qty: 2, store: 'Costco', category: 'Dairy & Eggs', addedBy: AGENTS.grocery, key: 'milk' }),
      shop('Bananas', { category: 'Produce', note: 'Not too ripe', addedBy: AGENTS.grocery, key: 'bananas' }),
      shop('Eggs', { store: 'Costco', category: 'Dairy & Eggs', note: '2 dozen', addedBy: AGENTS.grocery, key: 'eggs' }),
      shop('Sourdough loaf', { category: 'Bakery' }),
      shop('Chicken thighs', { category: 'Meat & Fish', note: 'Boneless' }),
      shop('Greek yogurt', { category: 'Dairy & Eggs' }),
      shop('AA batteries', { category: 'Household', note: 'For Light the Night lanterns', addedBy: AGENTS.week, key: 'aa-batteries' }),
      shop('Granola bars', { category: 'Snacks', addedBy: AGENTS.grocery, key: 'granola' }),
      shop('Pumpkin carving kit', { category: 'Household', note: 'From the JK Halloween party email', suggested: true, addedBy: AGENTS.school, key: 'pumpkin-kit' }),
      shop('Lemons', { category: 'Produce', done: true, doneBy: P('hayley'), doneAt: added }),
    ],
  };

  // ---------------------------------------------------------------- chores
  const doneAt = at(now, 7, 40);
  let c = 0;
  const chore = (person, routine, title, icon, o) => Object.assign({
    id: fid('c', 'chor' + ('000' + (++c)).slice(-4)), person, routine, title, icon, stars: 1, due: null,
    recurrence: 'daily', doneToday: null, addedBy: AGENTS.chores,
  }, o || {});
  const chores = {
    items: [
      chore('lilly', 'morning', 'Make bed', '🛏️', { doneToday: { by: P('lilly'), at: doneAt } }),
      chore('lilly', 'morning', 'Brush teeth', '🪥', { doneToday: { by: P('lilly'), at: doneAt } }),
      chore('lilly', 'morning', 'Pack backpack', '🎒', { recurrence: 'weekdays' }),
      chore('daisy', 'morning', 'Brush teeth', '🪥', { doneToday: { by: P('daisy'), at: doneAt } }),
      chore('daisy', 'morning', 'Get dressed', '👕'),
      chore('hayley', 'morning', 'Pack lunches', '🥪', { stars: 0, recurrence: 'weekdays', addedBy: AGENTS.frame }),
      chore('any', 'morning', 'Feed the cat', '🐱', { stars: 1 }),
      chore('lilly', 'after', 'Unpack lunchbox', '🥪', { recurrence: 'weekdays' }),
      chore('lilly', 'after', 'Read for 20 min', '📖', { stars: 2 }),
      chore('daisy', 'after', 'Tidy the toys', '🧸'),
      chore('nate', 'after', 'Garbage + recycling out', '🗑️', { stars: 0, due: day(3), recurrence: null, addedBy: AGENTS.week, key: 'garbage' }),
      chore('any', 'after', 'Empty dishwasher', '🍽️', { stars: 2 }),
      chore('lilly', 'evening', 'Lay out clothes', '👕'),
      chore('lilly', 'evening', 'Shower', '🚿'),
      chore('daisy', 'evening', 'Bath', '🛁'),
      chore('daisy', 'evening', 'Pick two books', '📚'),
      chore('nate', 'evening', 'Lock up', 'lock', { stars: 0, addedBy: AGENTS.frame }),
      chore('any', 'evening', 'Wipe counters', '🧽'),
    ],
  };

  return { shopping, chores, brief };
}
