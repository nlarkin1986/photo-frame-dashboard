// Pure validation + sanitising for everything that reaches the board (agents and frame).
// Plain text only: NFC, control/bidi/zero-width stripped, whitespace collapsed, length-limited.
// Privacy fails closed: card/account numbers and email addresses are rejected, phone numbers are
// masked to the last 4 digits, and money / bank / fraud / codes / medical / legal text forces
// `private: true` (or is rejected where the contract has no private flag).
import crypto from 'node:crypto';
import { PERSON_IDS, isPerson, personByName } from './people.js';

// Auto keys (entries sent without a `key`) are an opaque hash of their content, so text never
// leaks through keys in change events or views.
export function autoKey(...parts) {
  return 'auto:' + crypto.createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16);
}

export const LIMITS = Object.freeze({
  shoppingText: 60, shoppingNote: 80, store: 24, category: 24, qtyMax: 99,
  shoppingPerCall: 50, shoppingOpenMax: 150,
  choreTitle: 40, choresPerCall: 60, choresMax: 200,
  whoName: 24, headline: 80, headlineMax: 4, careLabel: 40, special: 60, itemText: 100, time: 16, place: 60,
  decisionTitle: 80, decisionContext: 120, slotLabel: 24, todoText: 120, stillOpen: 60, comingUp: 100, note: 140,
  briefTitle: 60, linkLabel: 40, linkUrl: 200, label: 40, dismissReason: 60,
  itemsPerDay: 20, decisionsMax: 12, slotsMax: 7, candidatesMax: 8, todosMax: 30, listMax: 12,
  pendingMax: 50, frameOps: 20,
});

const REQUIRED = Symbol('required');

export const KEY_RE = /^[A-Za-z0-9:._-]{1,80}$/;
export const ID_RE = /^[a-z]_[a-z0-9]{8}$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const ROUTINES = ['morning', 'after', 'evening'];
export const RECURRENCES = ['daily', 'weekdays'];
export const ITEM_KINDS = ['timed', 'allDay', 'deadline', 'note'];
export const DECISION_KINDS = ['care', 'ride', 'other'];
// Icon names the frame can draw (js/icons.js); anything else must be a single emoji.
export const ICON_NAMES = Object.freeze([
  'home', 'calendar', 'tasks', 'cart', 'photo', 'bulb', 'lock', 'car', 'drop', 'box', 'door', 'bell', 'mic',
  'music', 'heart', 'star', 'pin', 'clock', 'person', 'bolt', 'film', 'utensils', 'sunrise', 'schedule',
  'pencil', 'timer', 'bike', 'footprints', 'sun', 'cloud', 'rain', 'partly', 'moon', 'check',
]);

export class ValidationError extends Error {
  constructor(details, status = 422) {
    super('invalid');
    this.name = 'ValidationError';
    this.status = status;
    this.details = details;
  }
}

// ------------------------------------------------------------------ text
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const SPACEY_RE = /[\t\n\r\u2028\u2029]/g;
const BIDI_ZW_RE = /[\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u00AD]/g;

export function cleanText(raw) {
  return String(raw)
    .normalize('NFC')
    .replace(SPACEY_RE, ' ')
    .replace(CONTROL_RE, '')
    .replace(BIDI_ZW_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/i;
const DIGIT_RUN_RE = /(?<!\d)(?:\d[ -]?){11,18}\d(?!\d)/g;
const LONG_DIGITS_RE = /(?<!\d)(?:\d[ -]?){7,18}\d(?!\d)/;
const ACCOUNT_WORD_RE = /\b(account|acct|routing|card|iban|member ?id)\b/i;
const PHONE_RE = /(?<![\d$])(?:\+?1[\s.-]?)?(?:\(\d{3}\)\s?|\d{3}[\s.-]?)\d{3}[\s.-]?\d{4}(?!\d)/g;
const HTML_RE = /<\s*[a-zA-Z/!?]/;
const PRIVATE_RES = [
  /\$\s?\d/, /\b\d[\d,.]*\s?(usd|dollars?)\b/i, /\busd\b/i,
  /\bending(?: in)?\s*[-#:]?\s*\d{4}\b/i, /\bx\d{4}\b/i, /[*•x]{2,}\s?\d{4}\b/i, /\blast (?:four|4)\b/i,
  /\b(zelle|venmo|paypal|cash ?app|wire|wired|bank|banking|fraud|scam|chargeback|routing)\b/i,
  /\b(pin|passwords?|passcode|verification code|security code|one[- ]time code|otp|2fa|ssn|social security)\b/i,
  /\b(doctor|dentist|orthodont\w*|pediatrician|clinic|hospital|urgent care|therap\w*|psych\w*|counsel(?:ing|ling)|medical|medications?|prescriptions?|diagnos\w*)\b/i,
  /\b(lawyer|attorney|court|lawsuit|custody|divorce|subpoena|legal|probate)\b/i,
];

export function luhn(digits) {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

function maskPhones(text) {
  return text.replace(PHONE_RE, (m) => 'xxx-xxx-' + m.replace(/\D/g, '').slice(-4));
}

// -> { text, private, reject: null | 'email-address' | 'card-number' | 'account-number' | 'html' }
export function classify(raw) {
  const text0 = cleanText(raw);
  if (HTML_RE.test(text0)) return { text: text0, private: false, reject: 'html' };
  if (EMAIL_RE.test(text0)) return { text: text0, private: false, reject: 'email-address' };
  for (const m of text0.matchAll(DIGIT_RUN_RE)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length >= 12 && digits.length <= 19 && luhn(digits)) return { text: text0, private: false, reject: 'card-number' };
  }
  if (ACCOUNT_WORD_RE.test(text0) && LONG_DIGITS_RE.test(maskPhones(text0))) return { text: text0, private: false, reject: 'account-number' };
  const text = maskPhones(text0);
  return { text, private: PRIVATE_RES.some((re) => re.test(text0)), reject: null };
}

const REJECT_MSG = {
  'html': 'plain text only (no HTML)',
  'email-address': 'email addresses are not allowed on the board',
  'card-number': 'card numbers are not allowed on the board',
  'account-number': 'account numbers are not allowed on the board',
};

// Collects errors; every validator returns the sanitised value (or undefined) and records problems.
export class Checker {
  constructor() { this.errors = []; }
  fail(path, message) { this.errors.push({ path, message }); return undefined; }
  get ok() { return this.errors.length === 0; }
  throwIfAny(status = 422) { if (!this.ok) throw new ValidationError(this.errors, status); }

  // opts: { max, required=true, allowPrivate=false, onPrivate(fn) }
  text(v, path, { max, required = true, allowPrivate = false, flags } = {}) {
    if (v === undefined || v === null || v === '') {
      return required ? this.fail(path, 'required') : undefined;
    }
    if (typeof v !== 'string') return this.fail(path, 'must be a string');
    const c = classify(v);
    if (c.reject) return this.fail(path, REJECT_MSG[c.reject]);
    if (!c.text) return required ? this.fail(path, 'required') : undefined;
    if ([...c.text].length > max) return this.fail(path, `at most ${max} characters`);
    if (c.private) {
      if (!allowPrivate) return this.fail(path, 'looks sensitive (money, bank, codes, medical or legal); not allowed here — use a private todo or day item instead');
      if (flags) flags.private = true;
    }
    return c.text;
  }

  bool(v, path, dflt = false) {
    if (v === undefined || v === null) return dflt === REQUIRED ? this.fail(path, 'required (true or false)') : dflt;
    if (typeof v !== 'boolean') return this.fail(path, 'must be true or false');
    return v;
  }

  int(v, path, { min, max, dflt }) {
    if (v === undefined || v === null) return dflt;
    if (!Number.isInteger(v) || v < min || v > max) return this.fail(path, `must be an integer ${min}–${max}`);
    return v;
  }

  key(v, path, { required = false } = {}) {
    if (v === undefined || v === null) return required ? this.fail(path, 'required') : undefined;
    if (typeof v !== 'string' || !KEY_RE.test(v)) return this.fail(path, 'must match ^[A-Za-z0-9:._-]{1,80}$');
    return v;
  }

  id(v, path) {
    if (typeof v !== 'string' || !ID_RE.test(v)) return this.fail(path, 'unknown id');
    return v;
  }

  date(v, path, { required = true } = {}) {
    if (v === undefined || v === null) return required ? this.fail(path, 'required') : null;
    if (!isIsoDate(v)) return this.fail(path, 'must be an ISO date YYYY-MM-DD');
    return v;
  }

  oneOf(v, path, list, { required = true, dflt } = {}) {
    if (v === undefined || v === null) return required ? this.fail(path, `required, one of ${list.join(', ')}`) : dflt;
    if (!list.includes(v)) return this.fail(path, `must be one of ${list.join(', ')}`);
    return v;
  }

  person(v, path, { required = true } = {}) {
    if (v === undefined || v === null) return required ? this.fail(path, `required, one of ${PERSON_IDS.join(', ')}`) : null;
    if (!isPerson(v)) return this.fail(path, `unknown person; valid ids: ${PERSON_IDS.join(', ')}`);
    return v;
  }

  // who = { person: id } | { name: text≤24 } | null. A bare person id string is accepted too.
  who(v, path) {
    if (v === undefined || v === null) return null;
    if (typeof v === 'string') {
      if (isPerson(v)) return { person: v };
      return this.fail(path, `unknown person "${cleanText(v).slice(0, 24)}"; use one of ${PERSON_IDS.join(', ')} or { "name": "…" }`);
    }
    if (typeof v !== 'object' || Array.isArray(v)) return this.fail(path, 'must be { "person": id } or { "name": text } or null');
    if (v.person !== undefined) {
      if (!isPerson(v.person)) return this.fail(path + '.person', `unknown person; valid ids: ${PERSON_IDS.join(', ')}`);
      return { person: v.person };
    }
    const name = this.text(v.name, path + '.name', { max: LIMITS.whoName });
    if (name === undefined) return undefined;
    const p = personByName(name);
    return p ? { person: p.id } : { name };
  }

  icon(v, path) {
    if (v === undefined || v === null || v === '') return 'star';
    if (typeof v !== 'string') return this.fail(path, 'must be an emoji or icon name');
    const s = v.normalize('NFC').trim();
    if (ICON_NAMES.includes(s)) return s;
    if (EMOJI_RE.test(s)) return s;
    return this.fail(path, `must be a single emoji or one of ${ICON_NAMES.join(', ')}`);
  }

  // https only, no credentials, ≤200 chars -> { host, label } (never a tappable URL).
  link(v, path) {
    if (v === undefined || v === null) return undefined;
    const raw = typeof v === 'string' ? v : v && typeof v === 'object' ? v.url : undefined;
    if (typeof raw !== 'string' || raw.length > LIMITS.linkUrl) return this.fail(path, 'must be an https URL ≤200 chars');
    let u;
    try { u = new URL(raw.trim()); } catch { return this.fail(path, 'must be an https URL'); }
    if (u.protocol !== 'https:' || u.username || u.password || !u.hostname) return this.fail(path, 'must be an https URL without credentials');
    const host = u.hostname.toLowerCase();
    const label = typeof v === 'object' && v.label != null ? this.text(v.label, path + '.label', { max: LIMITS.linkLabel }) : host;
    if (label === undefined) return undefined;
    return { host, label };
  }

  array(v, path, max, { required = false } = {}) {
    if (v === undefined || v === null) return required ? this.fail(path, 'required') : [];
    if (!Array.isArray(v)) return this.fail(path, 'must be an array');
    if (v.length > max) return this.fail(path, `at most ${max} entries`);
    return v;
  }

  object(v, path, { required = true } = {}) {
    if (v === undefined || v === null) return required ? this.fail(path, 'required') : undefined;
    if (typeof v !== 'object' || Array.isArray(v)) return this.fail(path, 'must be an object');
    return v;
  }
}

const EMOJI_UNIT = '(?:\\p{Extended_Pictographic}|\\p{Emoji_Presentation})(?:\\uFE0F|\\p{Emoji_Modifier})?';
const EMOJI_RE = new RegExp(`^(?:${EMOJI_UNIT}(?:\\u200D${EMOJI_UNIT}){0,4}|\\p{Regional_Indicator}{2}|[#*0-9]\\uFE0F?\\u20E3)$`, 'u');

export function isIsoDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function isMonday(s) {
  if (!isIsoDate(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay() === 1;
}

export function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export function weekTitle(week) {
  const end = addDays(week, 6);
  const [, m1, d1] = week.split('-').map(Number);
  const [, m2, d2] = end.split('-').map(Number);
  return m1 === m2 ? `${MONTHS[m1 - 1]} ${d1}–${d2}` : `${MONTHS[m1 - 1]} ${d1} – ${MONTHS[m2 - 1]} ${d2}`;
}

// Normalised shopping text for merging ("Milk, 2%!" == "milk 2%").
export function normText(s) {
  return cleanText(s).toLowerCase().replace(/[^\p{L}\p{N}%]+/gu, ' ').trim();
}

// ------------------------------------------------------------------ agent inputs
export function validateShoppingAdd(body) {
  const c = new Checker();
  const b = c.object(body, 'body');
  if (!b) c.throwIfAny();
  const list = c.array(b.items, 'items', LIMITS.shoppingPerCall, { required: true });
  if (list && list.length === 0) c.fail('items', 'at least one item');
  const items = (list || []).map((it, i) => {
    const p = `items[${i}]`;
    if (!c.object(it, p)) return null;
    return {
      key: c.key(it.key, p + '.key'),
      text: c.text(it.text, p + '.text', { max: LIMITS.shoppingText }),
      qty: c.int(it.qty, p + '.qty', { min: 1, max: LIMITS.qtyMax, dflt: 1 }),
      store: c.text(it.store, p + '.store', { max: LIMITS.store, required: false }) ?? null,
      category: c.text(it.category, p + '.category', { max: LIMITS.category, required: false }) ?? null,
      note: c.text(it.note, p + '.note', { max: LIMITS.shoppingNote, required: false }) ?? '',
      suggested: c.oneOf(it.confidence, p + '.confidence', ['sure', 'suggest'], { required: false, dflt: 'sure' }) === 'suggest',
    };
  });
  c.throwIfAny();
  return { items };
}

export function validateShoppingPatch(body) {
  const c = new Checker();
  const b = c.object(body, 'body');
  if (!b) c.throwIfAny();
  const out = {};
  if (b.done !== undefined) out.done = c.bool(b.done, 'done');
  if (b.qty !== undefined) out.qty = c.int(b.qty, 'qty', { min: 1, max: LIMITS.qtyMax });
  if (b.note !== undefined) out.note = c.text(b.note, 'note', { max: LIMITS.shoppingNote, required: false }) ?? '';
  for (const k of Object.keys(b)) if (!['done', 'qty', 'note'].includes(k)) c.fail(k, 'unknown field (allowed: done, qty, note)');
  if (c.ok && Object.keys(out).length === 0) c.fail('body', 'nothing to change (done, qty or note)');
  c.throwIfAny();
  return out;
}

export function validateChoresPut(body) {
  const c = new Checker();
  const b = c.object(body, 'body');
  if (!b) c.throwIfAny();
  const s = c.object(b.scope, 'scope', { required: false }) || {};
  const scope = {};
  if (s.person !== undefined) {
    scope.person = s.person === 'any' ? 'any' : c.person(s.person, 'scope.person');
  }
  if (s.routine !== undefined) scope.routine = c.oneOf(s.routine, 'scope.routine', ROUTINES);
  const list = c.array(b.chores, 'chores', LIMITS.choresPerCall, { required: true }) || [];
  const chores = list.map((ch, i) => {
    const p = `chores[${i}]`;
    if (!c.object(ch, p)) return null;
    const person = ch.person === 'any' ? 'any' : c.person(ch.person, p + '.person');
    const routine = c.oneOf(ch.routine, p + '.routine', ROUTINES);
    if (scope.person && person && person !== scope.person) c.fail(p + '.person', `outside scope (${scope.person})`);
    if (scope.routine && routine && routine !== scope.routine) c.fail(p + '.routine', `outside scope (${scope.routine})`);
    return {
      key: c.key(ch.key, p + '.key'),
      person, routine,
      title: c.text(ch.title, p + '.title', { max: LIMITS.choreTitle }),
      icon: c.icon(ch.icon, p + '.icon'),
      stars: c.int(ch.stars, p + '.stars', { min: 0, max: 3, dflt: 0 }),
      due: c.date(ch.due, p + '.due', { required: false }),
      recurrence: c.oneOf(ch.recurrence, p + '.recurrence', RECURRENCES, { required: false, dflt: null }),
    };
  });
  const keys = new Set();
  chores.forEach((ch, i) => {
    if (!ch) return;
    const k = ch.key || autoKey('c', ch.person, ch.routine, normText(ch.title || ''));
    if (keys.has(k)) c.fail(`chores[${i}].key`, 'duplicate chore in this request');
    keys.add(k);
    ch.key = k;
  });
  c.throwIfAny();
  return { scope, chores };
}

// Brief draft: agent keys, no ids. ops.publishBrief turns keys into stable server ids.
export function validateBriefPut(week, body) {
  const c = new Checker();
  if (!isMonday(week)) c.fail('week', 'must be the Monday of the week (YYYY-MM-DD)');
  const b = c.object(body, 'body');
  c.throwIfAny();
  if (b.week !== undefined && b.week !== week) c.fail('week', 'body.week does not match the URL');
  const inWeek = (d) => d >= week && d <= addDays(week, 6);
  const seen = {};
  const keyOf = (section, v, fallback, path) => {
    const k = c.key(v, path) || autoKey(section, fallback);
    seen[section] = seen[section] || new Set();
    if (seen[section].has(k)) c.fail(path, `duplicate key "${k}"`);
    seen[section].add(k);
    return k;
  };

  const title = c.text(b.title, 'title', { max: LIMITS.briefTitle, required: false }) || weekTitle(week);
  const source = c.object(b.source, 'source', { required: false });
  const sourceLabel = source && source.label != null ? c.text(source.label, 'source.label', { max: LIMITS.label }) : undefined;

  const headline = (c.array(b.headline, 'headline', LIMITS.headlineMax) || []).map((h, i) => {
    const p = `headline[${i}]`;
    const o = typeof h === 'string' ? { text: h } : c.object(h, p);
    if (!o) return null;
    const text = c.text(o.text, p + '.text', { max: LIMITS.headline });
    return { key: keyOf('headline', o.key, `h:${normText(text || '')}`, p + '.key'), person: c.person(o.person, p + '.person', { required: false }), text };
  });

  const decisions = (c.array(b.decisions, 'decisions', LIMITS.decisionsMax) || []).map((d, i) => {
    const p = `decisions[${i}]`;
    if (!c.object(d, p)) return null;
    const flags = { private: false };
    const title = c.text(d.title, p + '.title', { max: LIMITS.decisionTitle, allowPrivate: true, flags });
    const context = c.text(d.context, p + '.context', { max: LIMITS.decisionContext, required: false, allowPrivate: true, flags });
    const when = c.object(d.when, p + '.when');
    const date = when ? c.date(when.date, p + '.when.date') : undefined;
    const time = when ? c.text(when.time, p + '.when.time', { max: LIMITS.time, required: false }) : undefined;
    const key = keyOf('decisions', d.key, `d:${normText(title || '')}:${date}`, p + '.key');
    const slotKeys = new Set();
    let slots = (c.array(d.slots, p + '.slots', LIMITS.slotsMax) || []).map((s, j) => {
      const sp = `${p}.slots[${j}]`;
      if (!c.object(s, sp)) return null;
      const sk = c.key(s.key ?? s.id, sp + '.key') || `slot${j}`;
      if (slotKeys.has(sk)) c.fail(sp + '.key', `duplicate slot key "${sk}"`);
      slotKeys.add(sk);
      return {
        key: sk,
        label: c.text(s.label, sp + '.label', { max: LIMITS.slotLabel }),
        date: s.date == null ? undefined : c.date(s.date, sp + '.date'),
        who: c.who(s.who, sp + '.who'),
      };
    });
    if (slots.length === 0) slots = [{ key: 'main', label: 'Who', date: undefined, who: null }];
    return {
      key, title, context,
      when: { date, ...(time ? { time } : {}) },
      kind: c.oneOf(d.kind, p + '.kind', DECISION_KINDS, { required: false, dflt: 'other' }),
      slots,
      candidates: (c.array(d.candidates, p + '.candidates', LIMITS.candidatesMax) || []).map((w, j) => c.who(w, `${p}.candidates[${j}]`)).filter(Boolean),
      private: c.bool(d.private, p + '.private') || flags.private,
    };
  });
  const decisionKeys = new Set(decisions.filter(Boolean).map((d) => d.key));

  const rawDays = c.array(b.days, 'days', 7) || [];
  const byDate = {};
  rawDays.forEach((d, i) => {
    const p = `days[${i}]`;
    if (!c.object(d, p)) return;
    const date = c.date(d.date, p + '.date');
    if (!date) return;
    if (!inWeek(date)) return c.fail(p + '.date', `must be within ${week}..${addDays(week, 6)}`);
    if (byDate[date]) return c.fail(p + '.date', 'duplicate day');
    const care = d.care == null ? null : c.object(d.care, p + '.care');
    byDate[date] = {
      date,
      care: care
        ? { who: c.who(care.who, p + '.care.who'), needed: c.bool(care.needed, p + '.care.needed'), ...(care.label != null ? { label: c.text(care.label, p + '.care.label', { max: LIMITS.careLabel }) } : {}) }
        : { who: null, needed: false },
      specials: (c.array(d.specials, p + '.specials', LIMITS.listMax) || []).map((s, j) => {
        const sp = `${p}.specials[${j}]`;
        if (!c.object(s, sp)) return null;
        return { person: c.person(s.person, sp + '.person'), text: c.text(s.text, sp + '.text', { max: LIMITS.special }) };
      }),
      items: (c.array(d.items, p + '.items', LIMITS.itemsPerDay) || []).map((it, j) => {
        const ip = `${p}.items[${j}]`;
        if (!c.object(it, ip)) return null;
        const flags = { private: false };
        const text = c.text(it.text, ip + '.text', { max: LIMITS.itemText, allowPrivate: true, flags });
        const place = c.text(it.place, ip + '.place', { max: LIMITS.place, required: false, allowPrivate: true, flags });
        const time = c.text(it.time, ip + '.time', { max: LIMITS.time, required: false });
        let decision;
        if (it.decision != null) {
          decision = c.key(it.decision, ip + '.decision');
          if (decision && !decisionKeys.has(decision)) c.fail(ip + '.decision', 'must be the key of a decision in this brief');
        }
        return {
          key: keyOf('items', it.key, `i:${date}:${normText(text || '')}`, ip + '.key'),
          kind: c.oneOf(it.kind, ip + '.kind', ITEM_KINDS, { required: false, dflt: time ? 'timed' : 'note' }),
          ...(time ? { time } : {}),
          text,
          people: (c.array(it.people, ip + '.people', 6) || []).map((x, k) => c.person(x, `${ip}.people[${k}]`)),
          ...(place ? { place } : {}),
          ...(decision ? { decision } : {}),
          private: c.bool(it.private, ip + '.private') || flags.private,
        };
      }),
    };
  });
  const days = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(week, i);
    days.push(byDate[date] || { date, care: { who: null, needed: false }, specials: [], items: [] });
  }

  const todos = (c.array(b.todos, 'todos', LIMITS.todosMax) || []).map((t, i) => {
    const p = `todos[${i}]`;
    if (!c.object(t, p)) return null;
    const flags = { private: false };
    const text = c.text(t.text, p + '.text', { max: LIMITS.todoText, allowPrivate: true, flags });
    const link = c.link(t.link, p + '.link');
    if (link && classify(link.label).private) flags.private = true;
    return {
      key: keyOf('todos', t.key, `t:${normText(text || '')}`, p + '.key'),
      text,
      owner: c.who(t.owner, p + '.owner'),
      ...(t.due != null ? { due: c.date(t.due, p + '.due') } : {}),
      ...(link ? { link } : {}),
      private: c.bool(t.private, p + '.private') || flags.private,
    };
  });

  const simple = (field, max, textMax, prefix) => (c.array(b[field], field, max) || []).map((s, i) => {
    const p = `${field}[${i}]`;
    const o = typeof s === 'string' ? { text: s } : c.object(s, p);
    if (!o) return null;
    const text = c.text(o.text, p + '.text', { max: textMax });
    return { key: keyOf(field, o.key, `${prefix}:${normText(text || '')}`, p + '.key'), text };
  });
  const stillOpen = simple('stillOpen', LIMITS.listMax, LIMITS.stillOpen, 'o');
  const notes = simple('notes', LIMITS.listMax, LIMITS.note, 'n');
  const comingUp = (c.array(b.comingUp, 'comingUp', LIMITS.listMax) || []).map((s, i) => {
    const p = `comingUp[${i}]`;
    if (!c.object(s, p)) return null;
    const date = c.date(s.date, p + '.date');
    const text = c.text(s.text, p + '.text', { max: LIMITS.comingUp });
    const time = c.text(s.time, p + '.time', { max: LIMITS.time, required: false });
    const place = c.text(s.place, p + '.place', { max: LIMITS.place, required: false });
    return { key: keyOf('comingUp', s.key, `u:${date}:${normText(text || '')}`, p + '.key'), date, ...(time ? { time } : {}), text, ...(place ? { place } : {}) };
  });

  c.throwIfAny();
  return { week, title, sourceLabel, headline, days, decisions, todos, stillOpen, comingUp, notes };
}

// ------------------------------------------------------------------ frame ops (400 on bad input)
export const FRAME_OPS = ['shopping.add', 'shopping.toggle', 'shopping.remove', 'chore.done', 'brief.assign', 'brief.todo', 'brief.owner', 'brief.dismiss', 'pending.approve', 'pending.dismiss'];

export function validateFrameOps(ops) {
  const c = new Checker();
  if (!Array.isArray(ops) || ops.length === 0) { c.fail('ops', 'required'); c.throwIfAny(400); }
  if (ops.length > LIMITS.frameOps) { c.fail('ops', `at most ${LIMITS.frameOps}`); c.throwIfAny(400); }
  const out = ops.map((o, i) => {
    const p = `ops[${i}]`;
    if (!o || typeof o !== 'object' || Array.isArray(o)) return c.fail(p, 'must be an object');
    const op = c.oneOf(o.op, p + '.op', FRAME_OPS);
    switch (op) {
      case 'shopping.add': return { op, text: c.text(o.text, p + '.text', { max: LIMITS.shoppingText }), qty: c.int(o.qty, p + '.qty', { min: 1, max: LIMITS.qtyMax, dflt: 1 }), store: c.text(o.store, p + '.store', { max: LIMITS.store, required: false }) ?? null };
      case 'shopping.toggle': return { op, id: c.id(o.id, p + '.id'), done: c.bool(o.done, p + '.done', REQUIRED), by: c.who(o.by, p + '.by') };
      case 'shopping.remove': return { op, id: c.id(o.id, p + '.id') };
      case 'chore.done': return { op, id: c.id(o.id, p + '.id'), by: c.who(o.by, p + '.by'), done: c.bool(o.done, p + '.done', true) };
      case 'brief.assign': return { op, decision: c.id(o.decision, p + '.decision'), slot: c.id(o.slot, p + '.slot'), who: c.who(o.who, p + '.who') };
      case 'brief.todo': return { op, id: c.id(o.id, p + '.id'), done: c.bool(o.done, p + '.done', REQUIRED) };
      case 'brief.owner': return { op, id: c.id(o.id, p + '.id'), owner: c.who(o.owner, p + '.owner') };
      case 'brief.dismiss': return { op, kind: c.oneOf(o.kind, p + '.kind', ['decision', 'todo']), id: c.id(o.id, p + '.id'), reason: c.text(o.reason, p + '.reason', { max: LIMITS.dismissReason, required: false }) ?? '' };
      case 'pending.approve':
      case 'pending.dismiss': return { op, id: c.id(o.id, p + '.id') };
      default: return undefined;
    }
  });
  c.throwIfAny(400);
  return out;
}
