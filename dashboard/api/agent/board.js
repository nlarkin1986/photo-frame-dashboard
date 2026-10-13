// GET /api/agent/board — the board document for an outside agent (scope board:read).
// Private items carry their real text only for tokens with scope private:read.
// Optional ?week=YYYY-MM-DD (a Monday) returns that week's brief instead of the current one.
import { agentHandler, etagOf, json, readFresh } from '../../lib/board/http.js';
import { boardView } from '../../lib/board/redact.js';
import { isMonday } from '../../lib/board/schema.js';

export const GET = agentHandler({ scope: 'board:read' }, async ({ store, token, request }) => {
  const week = new URL(request.url).searchParams.get('week');
  if (week !== null && !isMonday(week)) return json({ error: 'invalid', details: [{ path: 'week', message: 'must be a Monday (YYYY-MM-DD)' }] }, 422);
  const { rev, doc, ctx } = await readFresh(store);
  const reveal = token.scopes.includes('private:read');
  // The representation depends on rev, the requested week and whether private text is shown.
  const etag = etagOf(rev, [week ? 'w' + week : '', reveal ? 'p' : ''].filter(Boolean).join('-'));
  if (request.headers.get('if-none-match') === etag) return json(null, 304, { ETag: etag });
  return { status: 200, body: boardView(doc, { today: ctx.today, week: ctx.week, reveal, audience: 'agent', briefWeek: week || undefined }), headers: { ETag: etag } };
});
