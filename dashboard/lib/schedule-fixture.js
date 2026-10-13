// Local-dev stand-in for the DHC tools display API (System A), used by api/schedule.js when
// DHC_ORIGIN is unset outside Vercel. It returns payloads in System A's display shape (photo
// refs as {id, v}; api/schedule.js rewrites them like real ones) and applies POST ops to an
// in-memory copy, so the frame UI can be exercised end to end with `npm run dev`.
import { mondayISO } from './dhc.js';

// Real lucide-react 1.47.0 inner markup, copied from DHC tools lib/week-icon-nodes.ts.
const ICONS = {
  'sunrise': '<path d="M12 2v8"/><path d="m4.93 10.93 1.41 1.41"/><path d="M2 18h2"/><path d="M20 18h2"/><path d="m19.07 10.93-1.41 1.41"/><path d="M22 22H2"/><path d="m8 6 4-4 4 4"/><path d="M16 18a4 4 0 0 0-8 0"/>',
  'sun': '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  'shirt': '<path d="M20.38 3.46 16 2a4 4 0 0 1-8 0L3.62 3.46a2 2 0 0 0-1.34 2.23l.58 3.47a1 1 0 0 0 .99.84H6v10c0 1.1.9 2 2 2h8a2 2 0 0 0 2-2V10h2.15a1 1 0 0 0 .99-.84l.58-3.47a2 2 0 0 0-1.34-2.23z"/>',
  'sport-shoe': '<path d="m15 10.42 4.8-5.07"/><path d="M19 18h3"/><path d="M9.5 22 21.414 9.415A2 2 0 0 0 21.2 6.4l-5.61-4.208A1 1 0 0 0 14 3v2a2 2 0 0 1-1.394 1.906L8.677 8.053A1 1 0 0 0 8 9c-.155 6.393-2.082 9-4 9a2 2 0 0 0 0 4h14"/>',
  'toothbrush': '<path d="M15 11c-2 2-4 2-6 4l-7 7"/><path d="m22 4-7.414 7.414-2-2A2 2 0 0114 6c0-.512.196-1.024.586-1.414A2 2 0 0116 4a2 2 0 013.262-1.552l2.152 2.138"/>',
  'bath': '<path d="M10 4 8 6"/><path d="M17 19v2"/><path d="M2 12h20"/><path d="M7 19v2"/><path d="M9 5 7.621 3.621A2.121 2.121 0 0 0 4 5v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/>',
  'bed': '<path d="M2 4v16"/><path d="M2 8h18a2 2 0 0 1 2 2v10"/><path d="M2 17h20"/><path d="M6 8v9"/>',
  'moon-star': '<path d="M18 5h4"/><path d="M20 3v4"/><path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"/>',
  'book-heart': '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"/><path d="M8.62 9.8A2.25 2.25 0 1 1 12 6.836a2.25 2.25 0 1 1 3.38 2.966l-2.626 2.856a.998.998 0 0 1-1.507 0z"/>',
  'utensils': '<path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/>',
  'egg-fried': '<circle cx="11.5" cy="12.5" r="3.5"/><path d="M3 8c0-3.5 2.5-6 6.5-6 5 0 4.83 3 7.5 5s5 2 5 6c0 4.5-2.5 6.5-7 6.5-2.5 0-2.5 2.5-6 2.5s-7-2-7-5.5c0-3 1.5-3 1.5-5C3.5 10 3 9 3 8Z"/>',
  'sandwich': '<path d="m2.37 11.223 8.372-6.777a2 2 0 0 1 2.516 0l8.371 6.777"/><path d="M21 15a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1h-5.25"/><path d="M3 15a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1h9"/><path d="m6.67 15 6.13 4.6a2 2 0 0 0 2.8-.4l3.15-4.2"/><rect width="20" height="4" x="2" y="11" rx="1"/>',
  'apple': '<path d="M12 6.528V3a1 1 0 0 1 1-1h0"/><path d="M18.237 21A15 15 0 0 0 22 11a6 6 0 0 0-10-4.472A6 6 0 0 0 2 11a15.1 15.1 0 0 0 3.763 10 3 3 0 0 0 3.648.648 5.5 5.5 0 0 1 5.178 0A3 3 0 0 0 18.237 21"/>',
  'school': '<path d="M14 21v-3a2 2 0 0 0-4 0v3"/><path d="M18 4.933V21"/><path d="m4 6 7.106-3.79a2 2 0 0 1 1.788 0L20 6"/><path d="m6 11-3.52 2.147a1 1 0 0 0-.48.854V19a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5a1 1 0 0 0-.48-.853L18 11"/><path d="M6 4.933V21"/><circle cx="12" cy="9" r="2"/>',
  'backpack': '<path d="M4 10a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M8 10h8"/><path d="M8 18h8"/><path d="M8 22v-6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/>',
  'book-open': '<path d="M12 5v16"/><path d="M20.001 19A2 2 0 0022 17V5a2 2 0 00-1.999-2L16 3.002A5 5 0 0012 5a5 5 0 00-4-2H4a2 2 0 00-2 2v12a2 2 0 001.999 2H8a5 5 0 014 2 5 5 0 014-2z"/>',
  'bike': '<circle cx="18.5" cy="17.5" r="3.5"/><circle cx="5.5" cy="17.5" r="3.5"/><circle cx="15" cy="5" r="1"/><path d="M12 17.5V14l-3-3 4-3 2 3h2"/>',
  'car': '<path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2"/><circle cx="7" cy="17" r="2"/><path d="M9 17h6"/><circle cx="17" cy="17" r="2"/>',
  'footprints': '<path d="M4 16v-2.38C4 11.5 2.97 10.5 3 8c.03-2.72 1.49-6 4.5-6C9.37 2 10 3.8 10 5.5c0 3.11-2 5.66-2 8.68V16a2 2 0 1 1-4 0Z"/><path d="M20 20v-2.38c0-2.12 1.03-3.12 1-5.62-.03-2.72-1.49-6-4.5-6C14.63 6 14 7.8 14 9.5c0 3.11 2 5.66 2 8.68V20a2 2 0 1 0 4 0Z"/><path d="M16 17h4"/><path d="M4 13h4"/>',
  'trees': '<path d="M10 10v.2A3 3 0 0 1 8.9 16H5a3 3 0 0 1-1-5.8V10a3 3 0 0 1 6 0Z"/><path d="M7 16v6"/><path d="M13 19v3"/><path d="M12 19h8.3a1 1 0 0 0 .7-1.7L18 14h.3a1 1 0 0 0 .7-1.7L16 9h.2a1 1 0 0 0 .8-1.7L13 3l-1.4 1.5"/>',
  'music': '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  'gamepad-2': '<line x1="6" x2="10" y1="11" y2="11"/><line x1="8" x2="8" y1="9" y2="13"/><line x1="15" x2="15.01" y1="12" y2="12"/><line x1="18" x2="18.01" y1="10" y2="10"/><path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z"/>',
  'tv': '<path d="m17 2-5 5-5-5"/><rect width="20" height="15" x="2" y="7" rx="2"/>',
  'star': '<path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/>',
  'heart': '<path d="M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5"/>',
};

const PICTURES = [
  { name: 'sunrise', label: 'Wake up', category: 'Routines' },
  { name: 'sun', label: 'Outside play', category: 'Outside' },
  { name: 'shirt', label: 'Get dressed', category: 'Routines' },
  { name: 'sport-shoe', label: 'Shoes on', category: 'Routines' },
  { name: 'toothbrush', label: 'Brush teeth', category: 'Routines' },
  { name: 'bath', label: 'Bath time', category: 'Routines' },
  { name: 'bed', label: 'Bedtime', category: 'Routines' },
  { name: 'moon-star', label: 'Good night', category: 'Routines' },
  { name: 'book-heart', label: 'Story time', category: 'Routines' },
  { name: 'utensils', label: 'Dinner', category: 'Food' },
  { name: 'egg-fried', label: 'Breakfast', category: 'Food' },
  { name: 'sandwich', label: 'Lunch', category: 'Food' },
  { name: 'apple', label: 'Snack', category: 'Food' },
  { name: 'school', label: 'School', category: 'School' },
  { name: 'backpack', label: 'Pack my bag', category: 'Routines' },
  { name: 'book-open', label: 'Reading', category: 'School' },
  { name: 'bike', label: 'Bike ride', category: 'Outside' },
  { name: 'car', label: 'Car ride', category: 'Places' },
  { name: 'footprints', label: 'Running', category: 'Outside' },
  { name: 'trees', label: 'Park', category: 'Outside' },
  { name: 'music', label: 'Music class', category: 'School' },
  { name: 'gamepad-2', label: 'Video games', category: 'Screens' },
  { name: 'tv', label: 'TV time', category: 'Screens' },
  { name: 'star', label: 'Star', category: 'Special' },
  { name: 'heart', label: 'Kindness', category: 'Special' },
];
const SECTIONS = [
  { key: 'morning', name: 'Morning', words: 'Sun is up' },
  { key: 'midday', name: 'Midday', words: 'Sun is high' },
  { key: 'afternoon', name: 'Afternoon', words: 'Sun is lower' },
  { key: 'evening', name: 'Evening', words: 'Sun goes down' },
  { key: 'bedtime', name: 'Bedtime', words: 'Moon is out' },
];
const MAX_CARDS = 12;

const ph = (id) => ({ id, v: 1 });
const KIDS = [
  {
    id: 'k1', name: 'Lilly', avatar: { feeling: 'happy' }, hidden: [],
    library: [
      { photo: ph('fx-lilly-park'), label: 'Park' },
      { photo: ph('fx-lilly-grandma'), label: "Grandma's house" },
      { photo: ph('fx-lilly-swim'), label: 'Swimming' },
      { photo: ph('fx-lilly-dance'), label: 'Dance class' },
    ],
  },
  {
    id: 'k2', name: 'Max', avatar: { photo: ph('fx-max') }, hidden: ['midday'],
    library: [
      { photo: ph('fx-max-lego'), label: 'Lego' },
      { photo: ph('fx-max-soccer'), label: 'Soccer' },
      { photo: ph('fx-lilly-grandma'), label: "Grandma's house" },
    ],
  },
];

function icon(name, label, extra) {
  return { icon: name, photo: null, label, time: '', length: '', travel: null, done: false, ...extra };
}
function photo(id, label, extra) {
  return { icon: null, photo: ph(id), label, time: '', length: '', travel: null, done: false, ...extra };
}

// Cards per kid per day of week (0 = Monday), keyed by section.
function plan(kidId, dow) {
  const weekend = dow >= 5;
  if (kidId === 'k1') {
    return {
      morning: weekend
        ? [icon('sunrise', 'Wake up', { time: '7:30' }), icon('egg-fried', 'Pancakes'), icon('shirt', 'Get dressed')]
        : [icon('sunrise', 'Wake up', { time: '7:00' }), icon('shirt', 'Get dressed'), icon('egg-fried', 'Breakfast'),
          icon('toothbrush', 'Brush teeth'), icon('school', 'School', { time: '8:15', travel: { choice: 'walk' } })],
      midday: weekend
        ? [icon('sandwich', 'Lunch', { time: '12:00' })]
        : [icon('sandwich', 'Lunch', { time: '12:00' }), icon('book-open', 'Reading', { length: '20 min' })],
      afternoon: dow === 2
        ? [photo('fx-lilly-swim', 'Swimming', { time: '3:30', length: '45 min', travel: { choice: 'car' } }), icon('apple', 'Snack')]
        : dow === 5
          ? [photo('fx-lilly-grandma', "Grandma's house", { time: '2:00', travel: { choice: 'car' } })]
          : [photo('fx-lilly-park', 'Park', { travel: { choice: 'bike' } }), icon('apple', 'Snack', { time: '3:30' })],
      evening: [icon('utensils', 'Dinner', { time: '6:00' }), icon('tv', 'TV time', { length: '30 min' })],
      bedtime: [icon('bath', 'Bath time', { time: '7:00' }), icon('book-heart', 'Story time'), icon('bed', 'Bedtime', { time: '7:30' })],
    };
  }
  return {
    morning: weekend
      ? [icon('sunrise', 'Wake up'), icon('egg-fried', 'Breakfast')]
      : [icon('sunrise', 'Wake up', { time: '6:45' }), icon('shirt', 'Get dressed'), icon('sport-shoe', 'Shoes on'),
        icon('backpack', 'Pack my bag'), icon('school', 'School', { time: '8:00', travel: { choice: 'car' } })],
    midday: [],
    afternoon: dow === 1 || dow === 3
      ? [photo('fx-max-soccer', 'Soccer', { time: '4:00', length: '1 hr', travel: { choice: 'bike' } })]
      : [icon('bike', 'Bike ride', { travel: null }), icon('gamepad-2', 'Video games', { length: '30 min' })],
    evening: [icon('utensils', 'Dinner', { time: '6:00' }), photo('fx-max-lego', 'Lego')],
    bedtime: [icon('toothbrush', 'Brush teeth'), icon('moon-star', 'Good night', { time: '8:00' })],
  };
}

function sectionIndexAt(date) {
  const m = date.getHours() * 60 + date.getMinutes();
  return m < 660 ? 0 : m < 780 ? 1 : m < 1020 ? 2 : m < 1170 ? 3 : 4;
}

function isoDay(monday, i) {
  const [y, m, d] = monday.split('-').map(Number);
  const x = new Date(y, m - 1, d + i);
  const p = (n) => (n < 10 ? '0' : '') + n;
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
}

// The display payload for `week` (a Monday). Only the week containing `now` is planned; past
// days are all done, today is done up to (and half of) the current section.
export function buildFixture(week = mondayISO(new Date()), now = new Date()) {
  const planned = week === mondayISO(now);
  const todayIdx = (now.getDay() + 6) % 7;
  const current = sectionIndexAt(now);
  let n = 0;
  const kids = KIDS.map((k) => ({
    id: k.id,
    name: k.name,
    avatar: JSON.parse(JSON.stringify(k.avatar)),
    library: JSON.parse(JSON.stringify(k.library)),
    days: Array.from({ length: 7 }, (_, dow) => {
      const cards = planned ? plan(k.id, dow) : {};
      return {
        date: isoDay(week, dow),
        sections: SECTIONS.filter((s) => !k.hidden.includes(s.key)).map((s) => {
          const list = (cards[s.key] || []).map((c) => ({ id: `${k.id}d${dow}c${++n}`, ...c }));
          const si = SECTIONS.indexOf(s);
          list.forEach((c, i) => {
            c.done = dow < todayIdx || (dow === todayIdx && (si < current || (si === current && i < Math.floor(list.length / 2))));
          });
          return { key: s.key, name: s.name, words: s.words, cards: list };
        }),
      };
    }),
  }));
  return {
    v: 1,
    updatedAt: new Date().toISOString(),
    week,
    planned,
    can: { tick: true, edit: true },
    kids,
    icons: { ...ICONS },
    pictures: PICTURES.map((p) => ({ ...p })),
  };
}

// ------------------------------------------------------------ in-memory store
const weeks = new Map();
let rev = 0;

function stateFor(week) {
  if (!weeks.has(week)) weeks.set(week, buildFixture(week));
  return weeks.get(week);
}
const copy = (x) => JSON.parse(JSON.stringify(x));

export function fixtureEtag(week) {
  return `"fx-${rev}|${week}"`;
}
export function fixtureDisplay(week) {
  return copy(stateFor(week));
}
export function resetFixture() {
  weeks.clear();
  rev = 0;
}

class OpError extends Error {
  constructor(status, error) { super(error); this.status = status; this.error = error; }
}
const gone = () => new OpError(409, 'gone');
const bad = () => new OpError(400, 'bad-op');

function locate(kid, cardId) {
  for (let d = 0; d < kid.days.length; d++) {
    for (const section of kid.days[d].sections) {
      const index = section.cards.findIndex((c) => c.id === cardId);
      if (index > -1) return { day: d, section, index, card: section.cards[index] };
    }
  }
  return null;
}
function sectionOf(kid, day, key) {
  const d = kid.days[day];
  const s = d && d.sections.find((x) => x.key === key);
  if (!s) throw bad();
  return s;
}
function applyPicture(kid, card, picture) {
  if (!picture || typeof picture !== 'object') throw bad();
  if (picture.kind === 'icon' && typeof picture.icon === 'string') {
    card.icon = picture.icon;
    card.photo = null;
  } else if (picture.kind === 'photo' && typeof picture.photo === 'string') {
    const entry = kid.library.find((l) => l.photo.id === picture.photo);
    if (!entry) throw gone();
    card.icon = null;
    card.photo = { ...entry.photo };
  } else throw bad();
}
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
function travel(v) {
  if (v == null) return null;
  const c = v && v.choice;
  return { choice: c === 'bike' || c === 'walk' || c === 'car' ? c : null };
}
function insertAt(list, index, card) {
  const i = Number.isInteger(index) ? Math.max(0, Math.min(index, list.length)) : list.length;
  list.splice(i, 0, card);
}

function applyOp(display, op) {
  const kid = display.kids.find((k) => k.id === op.kid);
  if (!kid) throw gone();
  switch (op.op) {
    case 'tick': {
      const loc = locate(kid, op.card);
      if (!loc) throw gone();
      loc.card.done = !!op.on;
      return;
    }
    case 'clearDayTicks': {
      const d = kid.days[op.day];
      if (!d) throw bad();
      d.sections.forEach((s) => s.cards.forEach((c) => { c.done = false; }));
      return;
    }
    case 'add': {
      const input = op.card || {};
      if (typeof input.id !== 'string' || !input.id) throw bad();
      if (locate(kid, input.id)) return; // idempotent by client id
      const section = sectionOf(kid, op.day, op.section);
      if (section.cards.length >= MAX_CARDS) throw new OpError(409, 'full');
      const card = {
        id: input.id, icon: null, photo: null, label: str(input.label, 60), time: str(input.time, 10),
        length: str(input.length, 20), travel: travel(input.travel), done: false,
      };
      applyPicture(kid, card, input.picture);
      insertAt(section.cards, op.index, card);
      display.planned = true;
      return;
    }
    case 'remove': {
      const loc = locate(kid, op.card);
      if (loc) loc.section.cards.splice(loc.index, 1);
      return;
    }
    case 'move': {
      const loc = locate(kid, op.card);
      if (!loc) throw gone();
      const to = sectionOf(kid, op.toDay, op.toSection);
      if (to !== loc.section && to.cards.length >= MAX_CARDS) throw new OpError(409, 'full');
      loc.section.cards.splice(loc.index, 1);
      insertAt(to.cards, op.index, loc.card);
      return;
    }
    case 'update': {
      const loc = locate(kid, op.card);
      if (!loc) throw gone();
      const set = op.set || {};
      if ('label' in set) loc.card.label = str(set.label, 60);
      if ('time' in set) loc.card.time = str(set.time, 10);
      if ('length' in set) loc.card.length = str(set.length, 20);
      if ('travel' in set) loc.card.travel = travel(set.travel);
      if ('picture' in set) applyPicture(kid, loc.card, set.picture);
      return;
    }
    default:
      throw bad();
  }
}

// Applies all ops or none. Returns { status, body } like System A's POST.
export function fixtureApply(week, ops) {
  const next = copy(stateFor(week));
  try {
    for (const op of ops) applyOp(next, op);
  } catch (e) {
    if (e instanceof OpError) return { status: e.status, body: { error: e.error } };
    throw e;
  }
  next.updatedAt = new Date().toISOString();
  weeks.set(week, next);
  rev++;
  return { status: 200, body: copy(next) };
}
