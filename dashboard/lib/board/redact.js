// Views of the stored board. Private items reach the frame (and agents without `private:read`)
// with their text replaced by a generic label; owner/time/people stay. Internal bookkeeping
// (`_set`, dismissed items for the frame) never leaves the server.
import { peopleList } from './people.js';

export const PRIVATE_LABELS = Object.freeze({
  appointment: 'Private appointment',
  item: 'Private item',
  decision: 'Private decision',
});

function strip(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) if (!k.startsWith('_')) out[k] = v;
  return out;
}

function dayItem(it, reveal) {
  const o = strip(it);
  if (!o.private || reveal) return o;
  const { place, key, ...rest } = o;
  return { ...rest, text: it.kind === 'timed' ? PRIVATE_LABELS.appointment : PRIVATE_LABELS.item };
}

function decision(d, reveal) {
  const o = strip(d);
  o.slots = d.slots.map(strip);
  if (!o.private || reveal) return o;
  const { context, key, ...rest } = o;
  return { ...rest, title: PRIVATE_LABELS.decision };
}

function todo(t, reveal) {
  const o = strip(t);
  if (!o.private || reveal) return o;
  const { link, key, ...rest } = o;
  return { ...rest, text: PRIVATE_LABELS.item };
}

// `who` sees the brief: 'frame' hides dismissed decisions/todos; agents see them flagged.
export function briefView(brief, { reveal = false, audience = 'frame' } = {}) {
  if (!brief) return null;
  const keep = (x) => audience !== 'frame' || !x.dismissed;
  return {
    week: brief.week,
    title: brief.title,
    publishedAt: brief.publishedAt,
    source: brief.source,
    headline: brief.headline.map(strip),
    days: brief.days.map((d) => ({
      date: d.date,
      care: { ...d.care },
      specials: d.specials.map(strip),
      items: d.items.map((it) => dayItem(it, reveal)),
    })),
    decisions: brief.decisions.filter(keep).map((d) => decision(d, reveal)),
    todos: brief.todos.filter(keep).map((t) => todo(t, reveal)),
    stillOpen: brief.stillOpen.map(strip),
    comingUp: brief.comingUp.map(strip),
    notes: brief.notes.map(strip),
  };
}

export function pendingView(p) {
  return { id: p.id, section: p.section, op: p.op, summary: p.summary, source: p.source, at: p.at };
}

// The board document (contract shape). `today` = YYYY-MM-DD, `week` = Monday of the frame's week.
export function boardView(doc, { today, week, reveal = false, audience = 'frame', briefWeek } = {}) {
  const done = (doc.choreDone && doc.choreDone[today]) || {};
  return {
    rev: doc.rev,
    people: peopleList(),
    shopping: { items: doc.shopping.items.map(strip) },
    chores: {
      items: doc.chores.items
        .filter((c) => audience !== 'frame' || !c._retired || done[c.id])
        .map((c) => ({ ...strip(c), doneToday: done[c.id] ? { ...done[c.id] } : null })),
    },
    brief: briefView(doc.briefs[briefWeek || week] || null, { reveal, audience }),
    pending: doc.pending.map(pendingView),
  };
}
