// PATCH  /api/agent/shopping/items/{id} {done?, qty?, note?}  (any agent may complete; only the
//        agent that added an item may change qty/note)
// DELETE /api/agent/shopping/items/{id}                       (only the agent that added it)
// Review-mode tokens get 202 {rev, status:"pending", pending} instead.
import { agentHandler, json, lastSegment, mutate } from '../../../../lib/board/http.js';
import { agentRemoveShopping, agentUpdateShopping } from '../../../../lib/board/ops.js';
import { ID_RE, validateShoppingPatch } from '../../../../lib/board/schema.js';

const notFound = () => json({ error: 'not-found' }, 404);

export const PATCH = agentHandler({ scope: 'shopping:write', write: true }, async ({ store, body, base, request }) => {
  const id = lastSegment(request);
  if (!ID_RE.test(id)) return notFound();
  const patch = validateShoppingPatch(body);
  const { rev, result } = await mutate(store, base, (doc, ctx) => agentUpdateShopping(doc, id, patch, ctx));
  if (result.status === 'pending') return { status: 202, body: { rev, ...result } };
  return { status: 200, body: { rev, ...result } };
});

export const DELETE = agentHandler({ scope: 'shopping:write', write: true, body: false }, async ({ store, base, request }) => {
  const id = lastSegment(request);
  if (!ID_RE.test(id)) return notFound();
  const { rev, result } = await mutate(store, base, (doc, ctx) => agentRemoveShopping(doc, id, ctx));
  return { status: result.status === 'pending' ? 202 : 200, body: { rev, ...result } };
});
