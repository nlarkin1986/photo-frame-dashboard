// GET /api/agent/changes?since=<rev|last>[&section=shopping,chores,brief][&peek=1]
// -> {next, events:[{rev,section,op,id,key,actor,actorLabel,at,summary,…}], more?, gap?}
// since=<rev>: events after that revision (store `next` yourself; 0 the first time).
// since=last:  events after this token's server-side cursor, which then advances to `next`
//              (peek=1 reads without advancing). The first call returns the last 7 days.
// section filters events but the cursor still advances past everything returned as `next`.
// Whole revisions are never split across pages. `gap: true` means older events were trimmed.
// Shopping events also carry text, qty, store (and doneBy for check-offs).
import { agentHandler, json } from '../../lib/board/http.js';
import { listChanges, parseSections } from '../../lib/board/changes.js';

const bad = (path, message) => json({ error: 'invalid', details: [{ path, message }] }, 422);

export const GET = agentHandler({ scope: 'changes:read' }, async ({ store, token, request }) => {
  const q = new URL(request.url).searchParams;
  const raw = q.get('since');
  let since;
  if (raw === 'last') since = 'last';
  else if (/^\d{1,15}$/.test(raw)) since = Number(raw);
  else return bad('since', 'required: a revision number ≥ 0, or "last"');
  const sec = parseSections(q.get('section'));
  if (!sec.ok) return bad('section', 'comma list of shopping, chores, brief, pending');
  const peek = q.get('peek') === '1' || q.get('peek') === 'true';
  const body = await listChanges(store, { since, sections: sec.sections, peek, tokenId: token.id });
  return { status: 200, body };
});
