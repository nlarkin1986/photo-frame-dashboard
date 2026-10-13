// PUT /api/agent/brief/{week} — publish the weekly brief for the week starting Monday {week}.
// Body: Brief fields with the agent's own `key`s instead of ids. Optional If-Match: "r<rev>"
// -> 412 when the brief changed (frame answers or another publish) after that revision.
// Republishing keeps the family's answers (who, done, owner, dismissed) matched by key.
import { agentHandler, BRIEF_BODY, etagOf, json, lastSegment, mutate, parseIfMatch } from '../../../lib/board/http.js';
import { agentPublishBrief } from '../../../lib/board/ops.js';
import { briefView } from '../../../lib/board/redact.js';
import { validateBriefPut } from '../../../lib/board/schema.js';

export const PUT = agentHandler({ scope: 'brief:write', write: true, maxBody: BRIEF_BODY }, async ({ store, token, body, base, request }) => {
  const week = lastSegment(request);
  const im = parseIfMatch(request.headers.get('if-match'));
  if (!im.ok) return json({ error: 'invalid', details: [{ path: 'If-Match', message: 'must be "r<rev>"' }] }, 422);
  const draft = validateBriefPut(week, body);
  const { rev, result } = await mutate(store, base, (doc, ctx) => agentPublishBrief(doc, draft, ctx, { ifMatch: im.rev }));
  if (result.status === 'pending') return { status: 202, body: { rev, ...result } };
  const reveal = token.scopes.includes('private:read');
  return { status: 200, body: { rev, week, brief: briefView(result.brief, { reveal, audience: 'agent' }) }, headers: { ETag: etagOf(rev) } };
});
