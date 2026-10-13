// PUT /api/agent/chores {scope:{person?,routine?}, chores:[…]} — replaces only this agent's chores
// inside scope. -> {rev, results:[{key,id,status:"created"|"updated"|"unchanged"}], removed:[id]}
import { agentHandler, mutate } from '../../lib/board/http.js';
import { agentSetChores } from '../../lib/board/ops.js';
import { validateChoresPut } from '../../lib/board/schema.js';

export const PUT = agentHandler({ scope: 'chores:write', write: true }, async ({ store, body, base }) => {
  const input = validateChoresPut(body);
  const { rev, result } = await mutate(store, base, (doc, ctx) => agentSetChores(doc, input, ctx));
  return { status: result.status === 'pending' ? 202 : 200, body: { rev, ...result } };
});
