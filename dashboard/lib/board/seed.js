// Dev only: turn lib/board/fixture.js output ({shopping, chores, brief} in contract shape) into a
// stored board document for the in-memory store. Lenient — fixture data is trusted sample data.
import { emptyDoc, FRAME_ACTOR, makeCtx, randomId } from './ops.js';
import { ID_RE } from './schema.js';

const arr = (x) => (Array.isArray(x) ? x : []);
const okId = (id, prefix) => (typeof id === 'string' && ID_RE.test(id) ? id : randomId(prefix));

export function seedFromFixture(fx, now = new Date()) {
  const doc = emptyDoc();
  if (!fx || typeof fx !== 'object') return doc;
  const ctx = makeCtx({ now });
  const items = arr(fx.shopping && fx.shopping.items);
  doc.shopping.items = items.map((s) => ({
    id: okId(s.id, 's'), ...(s.key ? { key: s.key } : {}),
    text: String(s.text || ''), qty: Number.isInteger(s.qty) ? s.qty : 1, store: s.store ?? null, category: s.category ?? null,
    note: s.note || '', suggested: !!s.suggested, done: !!s.done, doneBy: s.doneBy ?? null, doneAt: s.doneAt ?? null,
    addedBy: s.addedBy || { ...FRAME_ACTOR }, addedAt: s.addedAt || ctx.at, updatedAt: s.updatedAt || s.addedAt || ctx.at,
  }));
  const done = {};
  doc.chores.items = arr(fx.chores && fx.chores.items).map((c) => {
    const id = okId(c.id, 'c');
    if (c.doneToday) done[id] = { by: c.doneToday.by ?? null, at: c.doneToday.at || ctx.at };
    const { doneToday, ...rest } = c;
    return { ...rest, id, stars: rest.stars ?? 0, due: rest.due ?? null, recurrence: rest.recurrence ?? null, addedBy: rest.addedBy || { ...FRAME_ACTOR } };
  });
  doc.choreDone[ctx.today] = done;
  const b = fx.brief;
  if (b && typeof b.week === 'string') {
    doc.briefs[b.week] = {
      week: b.week, title: b.title || '', publishedAt: b.publishedAt || ctx.at, source: b.source || { ...FRAME_ACTOR },
      headline: arr(b.headline), days: arr(b.days).map((d) => ({ date: d.date, care: d.care || { who: null, needed: false }, specials: arr(d.specials), items: arr(d.items) })),
      decisions: arr(b.decisions).map((d) => ({ ...d, slots: arr(d.slots), candidates: arr(d.candidates), done: !!d.done, private: !!d.private, _set: { slots: {} } })),
      todos: arr(b.todos).map((t) => ({ ...t, done: !!t.done, private: !!t.private, _set: {} })),
      stillOpen: arr(b.stillOpen), comingUp: arr(b.comingUp), notes: arr(b.notes), _rev: 0,
    };
  }
  return doc;
}
