// Reading the change log: numeric `since` or a server-side cursor per token ("since=last"),
// section filters, flip-collapsing, and the plain-language shopping digest for chat bots
// (e.g. a stateless Grok bot that must hear about what the family ticked off on the frame).
export const PAGE = 200;
export const FIRST_WINDOW_MS = 7 * 24 * 3600 * 1000;
export const FLIP_WINDOW_MS = 60 * 1000;
export const SECTIONS = ['shopping', 'chores', 'brief', 'pending'];

// A done→undone→done flip of one shopping item within 60 s (between consecutive toggles)
// collapses to its final event; an even run (done→undone) nets to nothing and is dropped.
// Adds/removes are never collapsed.
export function collapseEvents(events, windowMs = FLIP_WINDOW_MS) {
  const drop = new Set();
  const runs = new Map();
  const finish = (r) => {
    if (r.idx.length < 2) return;
    r.idx.slice(0, -1).forEach((i) => drop.add(i));
    if (r.idx.length % 2 === 0) drop.add(r.idx[r.idx.length - 1]);
  };
  events.forEach((e, i) => {
    if (e.section !== 'shopping' || (e.op !== 'done' && e.op !== 'undone') || !e.id) return;
    const t = Date.parse(e.at);
    const r = runs.get(e.id);
    if (r && t - r.last <= windowMs) {
      r.idx.push(i);
      r.last = t;
    } else {
      if (r) finish(r);
      runs.set(e.id, { idx: [i], last: t });
    }
  });
  for (const r of runs.values()) finish(r);
  return events.filter((_, i) => !drop.has(i));
}

export function parseSections(raw) {
  if (raw == null || raw === '') return { ok: true, sections: null };
  const list = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
  if (!list.length || list.some((s) => !SECTIONS.includes(s))) return { ok: false };
  return { ok: true, sections: list };
}

// -> { next, events, more?, gap? } (+ since, cursor in 'last' mode). `since` is a number or 'last'.
// In 'last' mode the token's cursor (`cursorName`) is read and, unless peek, advanced to the
// overall `next` — even when `sections` filters the events — so nothing is ever replayed.
export async function listChanges(store, { since, sections = null, peek = false, tokenId, cursorName = '', now = Date.now() }) {
  const all = await store.changes(0);
  let from = since;
  let first = false;
  if (since === 'last') {
    const cur = await store.cursorGet(tokenId, cursorName);
    if (cur == null) {
      first = true;
      const cutoff = now - FIRST_WINDOW_MS;
      const firstNew = all.events.find((e) => Date.parse(e.at) >= cutoff);
      from = firstNew ? firstNew.rev - 1 : all.rev;
    } else {
      from = Math.min(cur, all.rev);
    }
  }
  const newer = all.events.filter((e) => e.rev > from);
  let page = newer;
  let more = false;
  if (newer.length > PAGE) {
    const cut = newer[PAGE].rev;
    page = newer.filter((e) => e.rev < cut);
    if (!page.length) page = newer.filter((e) => e.rev === cut);
    more = true;
  }
  const next = more ? page[page.length - 1].rev : Math.max(all.rev, from);
  let events = collapseEvents(page);
  if (sections) events = events.filter((e) => sections.includes(e.section));
  if (since === 'last' && !peek) await store.cursorSet(tokenId, cursorName, next);
  const body = { next, events };
  if (more) body.more = true;
  if (!first && from > 0 && all.oldest != null && from < all.oldest - 1) body.gap = true;
  if (since === 'last') Object.assign(body, { since: from, cursor: { name: cursorName || 'changes', advanced: !peek, first } });
  return body;
}

// ------------------------------------------------------------------ shopping digest
const itemText = (e) => `${e.text}${e.qty > 1 ? ` (${e.qty})` : ''}`;
const where = (e) => (e.actor === 'frame' ? 'on the frame' : `by ${e.actorLabel || 'an agent'}`);

export function shoppingSentence(e) {
  if (!e.text) return null;
  switch (e.op) {
    case 'add': return `${itemText(e)} was added ${where(e)}`;
    case 'merge': return `${itemText(e)} was updated ${where(e)}`;
    case 'update': return `${itemText(e)} was changed ${where(e)}`;
    case 'done': return `${itemText(e)} was checked off ${where(e)}${e.doneBy ? ` by ${e.doneBy}` : ''}`;
    case 'undone': return `${itemText(e)} was put back on the list ${where(e)}`;
    case 'remove': return `${itemText(e)} was removed ${where(e)}`;
    default: return null;
  }
}

const brief = (s) => ({ text: s.text, qty: s.qty, store: s.store ?? null });
const listText = (items, max) => {
  const shown = items.slice(0, max).map((s) => `${s.text}${s.qty > 1 ? ` ×${s.qty}` : ''}${s.store ? ` (${s.store})` : ''}`);
  return shown.join(', ') + (items.length > max ? `, +${items.length - max} more` : '');
};

// The calling token's own writes are left out of since_last_check (it already knows them).
export function shoppingDigest(doc, events, tokenId) {
  const since = events.filter((e) => e.section === 'shopping' && e.actor !== tokenId).map(shoppingSentence).filter(Boolean);
  const open = doc.shopping.items.filter((s) => !s.done);
  const stillNeeded = open.filter((s) => !s.suggested).map(brief);
  const suggested = open.filter((s) => s.suggested).map(brief);
  const lines = [];
  if (since.length) {
    lines.push(`Since your last check: ${since.slice(0, 4).join('; ')}${since.length > 4 ? `; and ${since.length - 4} more` : ''}.`);
  } else {
    lines.push('No shopping changes since your last check.');
  }
  lines.push(stillNeeded.length ? `Still needed (${stillNeeded.length}): ${listText(stillNeeded, 8)}.` : 'The shopping list is empty.');
  if (suggested.length) lines.push(`Suggested, not confirmed (${suggested.length}): ${listText(suggested, 5)}.`);
  return {
    since_last_check: since,
    still_needed: stillNeeded,
    suggested,
    counts: { changes: since.length, still_needed: stillNeeded.length, suggested: suggested.length, checked_off: doc.shopping.items.length - open.length },
    summary: lines.join('\n'),
  };
}
