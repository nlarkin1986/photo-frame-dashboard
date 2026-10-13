// POST /api/agent/shopping/items {items:[{key?,text,qty?,store?,category?,note?,confidence?}]}
// -> {rev, results:[{key,id,status:"created"|"merged"|"unchanged"|"pending"}]}
import { agentHandler, mutate } from '../../../lib/board/http.js';
import { agentAddShopping } from '../../../lib/board/ops.js';
import { validateShoppingAdd } from '../../../lib/board/schema.js';

export const POST = agentHandler({ scope: 'shopping:write', write: true }, async ({ store, body, base }) => {
  const { items } = validateShoppingAdd(body);
  const { rev, result } = await mutate(store, base, (doc, ctx) => agentAddShopping(doc, items, ctx));
  return { status: 200, body: { rev, results: result } };
});
