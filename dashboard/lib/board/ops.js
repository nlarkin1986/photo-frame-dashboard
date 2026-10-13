// Pure domain operations on the stored board document. Used by the agent REST API, the frame
// endpoint and (later) MCP. Every op mutates the document it is given (the store hands it a
// fresh copy on each CAS attempt), pushes change events to ctx.events, and returns a result.
// The server sets ids, provenance and timestamps; agents correlate with their own `key`s.
import crypto from 'node:crypto';
import { addDays, LIMITS, normText, weekTitle } from './schema.js';
import { PEOPLE } from './people.js';
import { PRIVATE_LABELS } from './redact.js';

export const FRAME_ACTOR = Object.freeze({ agent: 'frame', label: 'Frame' });
export const DEFAULT_TZ = 'America/Chicago';

export class OpError extends Error {
  constructor(status, error, extra = {}) {
    super(error);
    this.name = 'OpError';
    this.status = status;
    this.error = error;
    this.extra = extra;
  }
}

export function emptyDoc() {
  return { v: 1, rev: 0, day: null, shopping: { items: [] }, chores: { items: [] }, choreDone: {}, briefs: {}, pending: [] };
}

// ------------------------------------------------------------------ ids + dates
const ALPHA = 'abcdefghijklmnopqrstuvwxyz0123456789';
function toId(prefix, bytes) {
  let s = '';
  for (let i = 0; i < 8; i++) s += ALPHA[bytes[i] % 36];
  return `${prefix}_${s}`;
}
export function randomId(prefix) {
  return toId(prefix, crypto.randomBytes(8));
}
// Same agent + same key (+ week) -> same id, so republishing never churns ids.
export function stableId(prefix, ...parts) {
  return toId(prefix, crypto.createHash('sha256').update(parts.join('\u0000')).digest());
}

export function todayIn(tz = DEFAULT_TZ, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export function mondayOf(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return addDays(iso, -((dow + 6) % 7));
}

// ctx: { actor:{agent,label}, mode:'direct'|'review', now:Date, today, week, events:[] }
export function makeCtx({ actor = FRAME_ACTOR, mode = 'direct', now = new Date(), tz = process.env.BOARD_TZ || DEFAULT_TZ, events = [] } = {}) {
  const today = todayIn(tz, now);
  return { actor, mode, now, at: now.toISOString(), today, week: mondayOf(today), events };
}

function emit(ctx, section, op, { id = null, key = null, summary = '', extra = null } = {}) {
  ctx.events.push({ section, op, id, key: key || null, actor: ctx.actor.agent, actorLabel: ctx.actor.label, at: ctx.at, summary: summary.slice(0, 120), ...(extra || {}) });
}

// Shopping events carry the item itself so chat bots can phrase them without another read
// (shopping text is never private: sensitive text is rejected for shopping).
function shopFields(item, doneBy) {
  return { text: item.text, qty: item.qty, store: item.store ?? null, ...(doneBy !== undefined ? { doneBy } : {}) };
}

function whoName(w) {
  if (!w) return 'nobody';
  if (w.person) return (PEOPLE.find((p) => p.id === w.person) || {}).name || w.person;
  return w.name;
}
const qtyText = (it) => it.text + (it.qty > 1 ? ` ×${it.qty}` : '');

// ------------------------------------------------------------------ day rollover
// Called before reads/writes: when the household's date changes, bump rev (so ETags change),
// drop yesterday's retired chores, done shopping older than 2 days, old done-state and old briefs.
export function needsRollover(doc, ctx) {
  return doc.day !== ctx.today;
}
export function rollover(doc, ctx) {
  if (doc.day === ctx.today) return false;
  doc.day = ctx.today;
  const keepFrom = addDays(ctx.today, -14);
  for (const d of Object.keys(doc.choreDone)) if (d < keepFrom) delete doc.choreDone[d];
  doc.chores.items = doc.chores.items.filter((c) => !c._retired);
  const cutoff = ctx.now.getTime() - 48 * 3600 * 1000;
  doc.shopping.items = doc.shopping.items.filter((s) => !s.done || !s.doneAt || Date.parse(s.doneAt) >= cutoff);
  const oldest = addDays(ctx.week, -7);
  for (const w of Object.keys(doc.briefs)) if (w < oldest) delete doc.briefs[w];
  return true;
}

// ------------------------------------------------------------------ shopping
function sameStore(a, b) {
  return !a || !b || a.toLowerCase() === b.toLowerCase();
}

// "Need at least N": merging never lowers qty and never doubles it.
function applyNeed(item, it) {
  let changed = false;
  if (it.qty > item.qty) { item.qty = it.qty; changed = true; }
  if (it.store && !item.store) { item.store = it.store; changed = true; }
  if (it.category && !item.category) { item.category = it.category; changed = true; }
  if (it.note && !item.note) { item.note = it.note; changed = true; }
  if (item.suggested && it.suggested === false) { item.suggested = false; changed = true; }
  return changed;
}

export function addShoppingItem(doc, it, ctx) {
  const items = doc.shopping.items;
  const agent = ctx.actor.agent;
  let target = null;
  if (it.key) {
    target = items.find((x) => x.key === it.key && x.addedBy.agent === agent) || null;
    // Already bought: a replay must not put it back on the list.
    if (target && target.done) return { key: it.key, id: target.id, status: 'unchanged' };
  }
  if (!target) {
    const n = normText(it.text);
    target = items.find((x) => !x.done && normText(x.text) === n && sameStore(x.store, it.store)) || null;
  }
  if (target) {
    const changed = applyNeed(target, it);
    if (changed) {
      target.updatedAt = ctx.at;
      emit(ctx, 'shopping', 'merge', { id: target.id, key: it.key, summary: `${qtyText(target)} (merged)`, extra: shopFields(target) });
    }
    return { key: it.key ?? null, id: target.id, status: changed ? 'merged' : 'unchanged' };
  }
  if (items.filter((x) => !x.done).length >= LIMITS.shoppingOpenMax) throw new OpError(409, 'shopping-full');
  const item = {
    id: randomId('s'),
    ...(it.key ? { key: it.key } : {}),
    text: it.text, qty: it.qty || 1, store: it.store ?? null, category: it.category ?? null, note: it.note || '',
    suggested: !!it.suggested, done: false, doneBy: null, doneAt: null,
    addedBy: { ...ctx.actor }, addedAt: ctx.at, updatedAt: ctx.at,
  };
  items.push(item);
  emit(ctx, 'shopping', 'add', { id: item.id, key: it.key, summary: `Added ${qtyText(item)}`, extra: shopFields(item) });
  return { key: it.key ?? null, id: item.id, status: 'created' };
}

function findShopping(doc, id) {
  const item = doc.shopping.items.find((x) => x.id === id);
  if (!item) throw new OpError(404, 'not-found');
  return item;
}

// Any agent may complete an item; only the agent that added it may edit qty/note.
export function updateShoppingItem(doc, id, patch, ctx) {
  const item = findShopping(doc, id);
  const frame = ctx.actor.agent === 'frame';
  if (!frame && (patch.qty !== undefined || patch.note !== undefined) && item.addedBy.agent !== ctx.actor.agent) {
    throw new OpError(403, 'not-owner');
  }
  let changed = false;
  if (patch.done !== undefined && patch.done !== item.done) {
    item.done = patch.done;
    item.doneAt = patch.done ? ctx.at : null;
    item.doneBy = patch.done ? (patch.doneBy ?? null) : null;
    changed = true;
    emit(ctx, 'shopping', patch.done ? 'done' : 'undone', { id, key: item.key, summary: `${item.text} ${patch.done ? 'checked off' : 'back on the list'}`, extra: shopFields(item, patch.done && item.doneBy ? whoName(item.doneBy) : null) });
  }
  if (patch.qty !== undefined && patch.qty !== item.qty) { item.qty = patch.qty; changed = true; }
  if (patch.note !== undefined && patch.note !== item.note) { item.note = patch.note; changed = true; }
  if (changed) {
    item.updatedAt = ctx.at;
    if (patch.qty !== undefined || patch.note !== undefined) emit(ctx, 'shopping', 'update', { id, key: item.key, summary: `${qtyText(item)} updated`, extra: shopFields(item) });
  }
  return { item: { ...item }, status: changed ? 'updated' : 'unchanged' };
}

export function removeShoppingItem(doc, id, ctx) {
  const item = findShopping(doc, id);
  if (ctx.actor.agent !== 'frame' && item.addedBy.agent !== ctx.actor.agent) throw new OpError(403, 'not-owner');
  doc.shopping.items = doc.shopping.items.filter((x) => x.id !== id);
  emit(ctx, 'shopping', 'remove', { id, key: item.key, summary: `Removed ${item.text}`, extra: shopFields(item) });
  return { id, status: 'removed' };
}

// ------------------------------------------------------------------ chores
function inScope(c, scope) {
  return (!scope.person || c.person === scope.person) && (!scope.routine || c.routine === scope.routine);
}

// Replaces only this agent's chores inside `scope`. Dropped chores already done today stay
// (retired) until the next day so the frame never loses a tick mid-day.
export function setChores(doc, { scope, chores }, ctx) {
  const agent = ctx.actor.agent;
  const done = doc.choreDone[ctx.today] || {};
  const results = [];
  const keepIds = new Set();
  for (const ch of chores) {
    const id = stableId('c', agent, ch.key);
    keepIds.add(id);
    const fields = { person: ch.person, routine: ch.routine, title: ch.title, icon: ch.icon, stars: ch.stars, due: ch.due ?? null, recurrence: ch.recurrence ?? null };
    const existing = doc.chores.items.find((c) => c.id === id);
    if (existing) {
      const same = Object.entries(fields).every(([k, v]) => existing[k] === v) && !existing._retired;
      Object.assign(existing, fields);
      delete existing._retired;
      results.push({ key: ch.key, id, status: same ? 'unchanged' : 'updated' });
    } else {
      if (doc.chores.items.filter((c) => !c._retired).length >= LIMITS.choresMax) throw new OpError(409, 'chores-full');
      doc.chores.items.push({ id, key: ch.key, ...fields, addedBy: { ...ctx.actor } });
      results.push({ key: ch.key, id, status: 'created' });
    }
  }
  const removed = [];
  doc.chores.items = doc.chores.items.filter((c) => {
    if (c.addedBy.agent !== agent || !inScope(c, scope) || keepIds.has(c.id)) return true;
    if (done[c.id]) { c._retired = true; return true; }
    removed.push(c.id);
    return false;
  });
  const changed = removed.length || results.some((r) => r.status !== 'unchanged');
  if (changed) emit(ctx, 'chores', 'set', { summary: choresSummary({ scope, chores }) });
  return { results, removed };
}

function choresSummary({ scope, chores }) {
  const who = scope.person ? (scope.person === 'any' ? 'anyone' : whoName({ person: scope.person })) : 'everyone';
  return `${chores.length} chore${chores.length === 1 ? '' : 's'} for ${who}${scope.routine ? ' · ' + scope.routine : ''}`;
}

export function markChore(doc, { id, by, done }, ctx) {
  const chore = doc.chores.items.find((c) => c.id === id);
  if (!chore) throw new OpError(409, 'gone', { id });
  const day = (doc.choreDone[ctx.today] = doc.choreDone[ctx.today] || {});
  if (done) day[id] = { by: by ?? null, at: ctx.at };
  else delete day[id];
  emit(ctx, 'chores', done ? 'done' : 'undone', { id, key: chore.key, summary: `${chore.title} ${done ? 'done' + (by ? ' by ' + whoName(by) : '') : 'not done'}` });
}

// ------------------------------------------------------------------ brief
export function checkBriefWeek(week, ctx) {
  if (week < addDays(ctx.week, -7) || week > addDays(ctx.week, 28)) {
    throw new OpError(422, 'invalid', { details: [{ path: 'week', message: 'must be between last week and 4 weeks ahead' }] });
  }
}

const answered = (x) => !!(x.dismissed || (x._set && (x._set.done || x._set.owner || Object.keys(x._set.slots || {}).length)));

// Agent keys -> stable ids. Frame-owned state (slot who, done, owner, dismissed) survives a
// republish when the key matches; answered items the agent dropped are kept as stale.
export function publishBrief(doc, draft, ctx, { ifMatch = null } = {}) {
  const { week } = draft;
  checkBriefWeek(week, ctx);
  const old = doc.briefs[week] || null;
  if (ifMatch != null && old && old._rev > ifMatch) throw new OpError(412, 'stale', { rev: old._rev });
  const agent = ctx.actor.agent;
  const sid = (p, ...k) => stableId(p, agent, week, ...k);
  const oldById = (list) => new Map(((old && old[list]) || []).map((x) => [x.id, x]));
  const oldDecisions = oldById('decisions');
  const oldTodos = oldById('todos');

  const decisions = draft.decisions.map((d) => {
    const id = sid('d', d.key);
    const prev = oldDecisions.get(id);
    const set = { slots: {} };
    const slots = d.slots.map((s) => {
      const slotId = sid('l', d.key, s.key);
      const prevSlot = prev && prev.slots.find((x) => x.id === slotId);
      let who = s.who;
      if (prevSlot && prev._set && prev._set.slots && prev._set.slots[slotId]) { who = prevSlot.who; set.slots[slotId] = true; }
      return { id: slotId, key: s.key, label: s.label, ...(s.date ? { date: s.date } : {}), who };
    });
    let doneVal = false;
    if (prev && prev._set && prev._set.done) { doneVal = prev.done; set.done = true; }
    return {
      id, key: d.key, title: d.title, ...(d.context ? { context: d.context } : {}), when: d.when, kind: d.kind,
      slots, candidates: d.candidates, done: doneVal, private: d.private,
      ...(prev && prev.dismissed ? { dismissed: prev.dismissed } : {}),
      _set: set,
    };
  });
  const decisionIdByKey = new Map(draft.decisions.map((d) => [d.key, sid('d', d.key)]));

  const todos = draft.todos.map((t) => {
    const id = sid('t', t.key);
    const prev = oldTodos.get(id);
    const set = {};
    let owner = t.owner;
    let doneVal = false;
    if (prev && prev._set && prev._set.owner) { owner = prev.owner; set.owner = true; }
    if (prev && prev._set && prev._set.done) { doneVal = prev.done; set.done = true; }
    return {
      id, key: t.key, text: t.text, owner, ...(t.due ? { due: t.due } : {}), ...(t.link ? { link: t.link } : {}),
      done: doneVal, private: t.private, ...(prev && prev.dismissed ? { dismissed: prev.dismissed } : {}), _set: set,
    };
  });

  // Keep what the family already answered but this publish dropped.
  if (old) {
    const newIds = new Set([...decisions, ...todos].map((x) => x.id));
    for (const d of old.decisions) if (!newIds.has(d.id) && answered(d)) decisions.push({ ...d, stale: true });
    for (const t of old.todos) if (!newIds.has(t.id) && answered(t)) todos.push({ ...t, stale: true });
  }

  const brief = {
    week,
    title: draft.title || weekTitle(week),
    publishedAt: ctx.at,
    source: { ...ctx.actor },
    headline: draft.headline.map((h) => ({ id: sid('h', h.key), key: h.key, person: h.person ?? null, text: h.text })),
    days: draft.days.map((d) => ({
      date: d.date,
      care: d.care,
      specials: d.specials,
      items: d.items.map((it) => {
        const { decision, ...rest } = it;
        return { id: sid('i', it.key), ...rest, ...(decision ? { decision: decisionIdByKey.get(decision) } : {}) };
      }),
    })),
    decisions,
    todos,
    stillOpen: draft.stillOpen.map((s) => ({ id: sid('o', s.key), key: s.key, text: s.text })),
    comingUp: draft.comingUp.map((s) => ({ id: sid('u', s.key), ...s })),
    notes: draft.notes.map((s) => ({ id: sid('n', s.key), key: s.key, text: s.text })),
    _rev: doc.rev + 1,
  };
  doc.briefs[week] = brief;
  emit(ctx, 'brief', 'publish', { id: week, summary: `Weekly brief ${brief.title} published` });
  return { week, brief };
}

function findBriefThing(doc, list, id, ctx) {
  const weeks = Object.keys(doc.briefs).sort((a, b) => (a === ctx.week ? -1 : b === ctx.week ? 1 : b.localeCompare(a)));
  for (const w of weeks) {
    const brief = doc.briefs[w];
    const x = brief[list].find((y) => y.id === id);
    if (x) return { brief, x };
  }
  throw new OpError(409, 'gone', { id });
}
// Private entries never expose their key (agent-chosen keys can carry the private text).
const pubKey = (x) => (x.private ? null : x.key);
const label = (x, field) => (x.private ? (field === 'title' ? PRIVATE_LABELS.decision : PRIVATE_LABELS.item) : x[field]);

export function briefAssign(doc, { decision, slot, who }, ctx) {
  const { brief, x: d } = findBriefThing(doc, 'decisions', decision, ctx);
  const s = d.slots.find((y) => y.id === slot);
  if (!s) throw new OpError(409, 'gone', { id: slot });
  s.who = who;
  d._set = d._set || { slots: {} };
  d._set.slots = d._set.slots || {};
  d._set.slots[slot] = true;
  d.done = d.slots.every((y) => y.who);
  d._set.done = true;
  brief._rev = doc.rev + 1;
  emit(ctx, 'brief', 'assign', { id: d.id, key: pubKey(d), summary: `${label(d, 'title')}${d.slots.length > 1 ? ' (' + s.label + ')' : ''} → ${whoName(who)}` });
}

export function briefTodo(doc, { id, done }, ctx) {
  const { brief, x: t } = findBriefThing(doc, 'todos', id, ctx);
  t.done = done;
  t._set = { ...(t._set || {}), done: true };
  brief._rev = doc.rev + 1;
  emit(ctx, 'brief', done ? 'todo.done' : 'todo.undone', { id, key: pubKey(t), summary: `${label(t, 'text')} ${done ? 'done' : 'not done'}` });
}

export function briefOwner(doc, { id, owner }, ctx) {
  const { brief, x: t } = findBriefThing(doc, 'todos', id, ctx);
  t.owner = owner;
  t._set = { ...(t._set || {}), owner: true };
  brief._rev = doc.rev + 1;
  emit(ctx, 'brief', 'todo.owner', { id, key: pubKey(t), summary: `${label(t, 'text')} → ${whoName(owner)}` });
}

export function briefDismiss(doc, { kind, id, reason }, ctx) {
  const { brief, x } = findBriefThing(doc, kind === 'decision' ? 'decisions' : 'todos', id, ctx);
  x.dismissed = { reason: reason || '', at: ctx.at };
  brief._rev = doc.rev + 1;
  emit(ctx, 'brief', 'dismiss', { id, key: pubKey(x), summary: `Dismissed ${label(x, kind === 'decision' ? 'title' : 'text')}${reason ? ': ' + reason : ''}` });
}

// ------------------------------------------------------------------ review queue
export function findPending(doc, agent, dedupe) {
  return doc.pending.find((p) => p.source.agent === agent && p._dedupe === dedupe) || null;
}

// A repeat suggestion with the same dedupe key replaces the queued one (callers merge partial
// payloads such as shopping patches first, so nothing an earlier call asked for is lost).
function queuePending(doc, { section, op, summary, payload, dedupe }, ctx) {
  const agent = ctx.actor.agent;
  const dup = dedupe && findPending(doc, agent, dedupe);
  if (dup) {
    dup.payload = payload;
    dup.summary = summary;
    dup.at = ctx.at;
    return dup;
  }
  if (doc.pending.length >= LIMITS.pendingMax) throw new OpError(409, 'pending-full');
  const p = { id: randomId('p'), section, op, summary, source: { ...ctx.actor }, at: ctx.at, payload, ...(dedupe ? { _dedupe: dedupe } : {}) };
  doc.pending.push(p);
  emit(ctx, 'pending', 'add', { id: p.id, summary: `Suggested: ${summary}` });
  return p;
}

// Agent writes. In review mode each write is dry-run first (so 404/403/422 still surface), then
// queued for Approve/Dismiss on the frame instead of being applied.
function trial(doc, fn, ctx) {
  return fn(structuredClone(doc), { ...ctx, events: [] });
}

export function agentAddShopping(doc, items, ctx) {
  if (ctx.mode !== 'review') return items.map((it) => addShoppingItem(doc, it, ctx));
  return items.map((it) => {
    const r = trial(doc, (d, c) => addShoppingItem(d, it, c), ctx);
    if (r.status === 'unchanged') return r;
    const p = queuePending(doc, { section: 'shopping', op: 'add', summary: `Add ${qtyText(it)}`, payload: { item: it }, dedupe: 'shop:' + (it.key || normText(it.text)) }, ctx);
    return { key: it.key ?? null, id: p.id, status: 'pending' };
  });
}

function patchSummary(item, patch) {
  const parts = [];
  if (patch.done === true) parts.push('check off');
  if (patch.done === false) parts.push('put back on the list');
  if (patch.qty !== undefined) parts.push(`qty ${patch.qty}`);
  if (patch.note !== undefined) parts.push(patch.note ? `note "${patch.note}"` : 'clear note');
  return `${item.text}: ${parts.join(', ')}`;
}

export function agentUpdateShopping(doc, id, patch, ctx) {
  if (ctx.mode !== 'review') return updateShoppingItem(doc, id, patch, ctx);
  const dedupe = `upd:${id}`;
  const prev = findPending(doc, ctx.actor.agent, dedupe);
  const merged = { ...(prev ? prev.payload.patch : {}), ...patch };
  const r = trial(doc, (d, c) => updateShoppingItem(d, id, merged, c), ctx);
  if (r.status === 'unchanged' && !prev) return r;
  const item = findShopping(doc, id);
  const p = queuePending(doc, { section: 'shopping', op: 'update', summary: patchSummary(item, merged), payload: { id, patch: merged }, dedupe }, ctx);
  return { status: 'pending', pending: p.id };
}

export function agentRemoveShopping(doc, id, ctx) {
  if (ctx.mode !== 'review') return removeShoppingItem(doc, id, ctx);
  trial(doc, (d, c) => removeShoppingItem(d, id, c), ctx);
  const item = findShopping(doc, id);
  const p = queuePending(doc, { section: 'shopping', op: 'remove', summary: `Remove ${item.text}`, payload: { id }, dedupe: `rm:${id}` }, ctx);
  return { status: 'pending', pending: p.id };
}

export function agentSetChores(doc, input, ctx) {
  if (ctx.mode !== 'review') return setChores(doc, input, ctx);
  trial(doc, (d, c) => setChores(d, input, c), ctx);
  const p = queuePending(doc, { section: 'chores', op: 'set', summary: `Set ${choresSummary(input)}`, payload: input, dedupe: `chores:${input.scope.person || '*'}:${input.scope.routine || '*'}` }, ctx);
  return { status: 'pending', pending: p.id };
}

export function agentPublishBrief(doc, draft, ctx, opts = {}) {
  if (ctx.mode !== 'review') return publishBrief(doc, draft, ctx, opts);
  trial(doc, (d, c) => publishBrief(d, draft, c, opts), ctx);
  const p = queuePending(doc, { section: 'brief', op: 'publish', summary: `Weekly brief · ${draft.title || weekTitle(draft.week)}`, payload: { draft }, dedupe: `brief:${draft.week}` }, ctx);
  return { status: 'pending', pending: p.id, week: draft.week };
}

export function approvePending(doc, id, ctx) {
  const p = doc.pending.find((x) => x.id === id);
  if (!p) throw new OpError(409, 'gone', { id });
  doc.pending = doc.pending.filter((x) => x.id !== id);
  // Replay as the agent that wrote it (provenance stays the agent's), in direct mode.
  const as = { ...ctx, actor: { ...p.source }, mode: 'direct' };
  const key = `${p.section}.${p.op}`;
  if (key === 'shopping.add') addShoppingItem(doc, p.payload.item, as);
  else if (key === 'shopping.update') updateShoppingItem(doc, p.payload.id, p.payload.patch, as);
  else if (key === 'shopping.remove') removeShoppingItem(doc, p.payload.id, as);
  else if (key === 'chores.set') setChores(doc, p.payload, as);
  else if (key === 'brief.publish') publishBrief(doc, p.payload.draft, as);
  emit(ctx, 'pending', 'approve', { id, summary: `Approved: ${p.summary}` });
}

export function dismissPending(doc, id, ctx) {
  const p = doc.pending.find((x) => x.id === id);
  if (!p) throw new OpError(409, 'gone', { id });
  doc.pending = doc.pending.filter((x) => x.id !== id);
  emit(ctx, 'pending', 'dismiss', { id, summary: `Dismissed: ${p.summary}` });
}

// ------------------------------------------------------------------ frame ops
// Ops arrive validated (schema.validateFrameOps). Applied in order inside one CAS write;
// any failure aborts the whole batch.
export function applyFrameOps(doc, ops, ctx) {
  for (const o of ops) {
    try {
      switch (o.op) {
        case 'shopping.add': addShoppingItem(doc, { text: o.text, qty: o.qty, store: o.store, suggested: false }, ctx); break;
        case 'shopping.toggle': updateShoppingItem(doc, o.id, { done: o.done, doneBy: o.by ?? null }, ctx); break;
        case 'shopping.remove': removeShoppingItem(doc, o.id, ctx); break;
        case 'chore.done': markChore(doc, o, ctx); break;
        case 'brief.assign': briefAssign(doc, o, ctx); break;
        case 'brief.todo': briefTodo(doc, o, ctx); break;
        case 'brief.owner': briefOwner(doc, o, ctx); break;
        case 'brief.dismiss': briefDismiss(doc, o, ctx); break;
        case 'pending.approve': approvePending(doc, o.id, ctx); break;
        case 'pending.dismiss': dismissPending(doc, o.id, ctx); break;
        default: throw new OpError(400, 'bad-ops');
      }
    } catch (e) {
      // A missing item from the frame's point of view is a conflict (it changed under it).
      if (e instanceof OpError && e.status === 404) throw new OpError(409, 'gone', { id: o.id });
      throw e;
    }
  }
}
