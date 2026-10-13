// GET /api/agent/shopping/updates[?peek=1] — the shopping digest for chat bots (scopes
// board:read + changes:read): what changed since this token last asked (its own shopping cursor,
// separate from /changes?since=last), what is still needed, suggestions, counts, and a 2–4 line
// `summary` a bot can relay verbatim. The token's own writes are left out of since_last_check.
import { agentHandler, readFresh } from '../../../lib/board/http.js';
import { listChanges, shoppingDigest } from '../../../lib/board/changes.js';

export const GET = agentHandler({ scope: ['board:read', 'changes:read'] }, async ({ store, token, request }) => {
  const q = new URL(request.url).searchParams;
  const peek = q.get('peek') === '1' || q.get('peek') === 'true';
  const ch = await listChanges(store, { since: 'last', sections: ['shopping'], peek, tokenId: token.id, cursorName: 'shopping' });
  const { doc } = await readFresh(store);
  return { status: 200, body: { ...shoppingDigest(doc, ch.events, token.id), next: ch.next, ...(ch.more ? { more: true } : {}) } };
});
