// Checks for the MCP endpoint (api/mcp.js): JSON-RPC over the handler with constructed Requests,
// in-memory store, no network.   node scripts/mcp-check.mjs
import assert from 'node:assert/strict';

for (const k of ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'VERCEL', 'FRAME_KEY', 'BOARD_DEV_TOKEN', 'BOARD_DEV_MODE', 'BOARD_STORE']) delete process.env[k];
process.env.BOARD_TZ = 'America/Chicago';
process.env.BOARD_DEV_TOKEN = 'dev-secret-for-mcp-check';

const { createMemoryStore, setStore } = await import('../lib/board/store.js');
const { createToken, revokeToken } = await import('../lib/board/tokens.js');
const { GET: mcpGET, POST: mcpPOST, DELETE: mcpDELETE } = await import('../api/mcp.js');
const { GET: restBoard } = await import('../api/agent/board.js');
const { bypassesFrameKey } = await import('../middleware.js');
const { POST: framePOST } = await import('../api/board.js');

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
  } catch (e) {
    console.error(`FAIL ${name}\n`, e);
    process.exitCode = 1;
  }
}

const store = createMemoryStore();
setStore(store);
const ALL = ['board:read', 'shopping:write', 'chores:write', 'brief:write', 'changes:read'];
const mk = async (label, scopes = ALL, mode = 'direct') => (await createToken(store, { label, scopes, mode })).token;

const PROTO = '2025-06-18';
let seq = 0;
function req(token, body, { method = 'POST', headers = {} } = {}) {
  const h = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTO, ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  return new Request('https://board.test/api/mcp', { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
}
// One JSON-RPC message -> parsed response message (JSON or a single SSE `data:` event).
async function rpc(token, method, params = {}) {
  const res = await mcpPOST(req(token, { jsonrpc: '2.0', id: ++seq, method, params }));
  assert.equal(res.status, 200, `${method} -> HTTP ${res.status}`);
  const text = await res.text();
  const type = res.headers.get('content-type') || '';
  if (type.includes('application/json')) return JSON.parse(text);
  const data = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).filter(Boolean);
  assert.ok(data.length >= 1, `no SSE data in: ${text.slice(0, 200)}`);
  return JSON.parse(data[data.length - 1]);
}
async function call(token, name, args = {}) {
  const msg = await rpc(token, 'tools/call', { name, arguments: args });
  assert.ok(!msg.error, `${name}: JSON-RPC error ${JSON.stringify(msg.error)}`);
  return msg.result;
}
const okResult = (r, name) => {
  assert.ok(!r.isError, `${name} failed: ${r.content && r.content[0] && r.content[0].text}`);
  assert.equal(r.content[0].type, 'text');
  assert.ok(r.content[0].text.length > 0);
  assert.deepEqual(JSON.parse(r.content[1].text), r.structuredContent, 'text JSON mirrors structuredContent');
  return r.structuredContent;
};
const errResult = (r, status) => {
  assert.equal(r.isError, true, `expected tool error ${status}, got ${JSON.stringify(r).slice(0, 300)}`);
  assert.equal(r.structuredContent.status, status, r.content[0].text);
  return r.structuredContent;
};

const FULL = await mk('Family agent');
const WEEK = (() => {
  const d = new Date();
  const dow = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow + 7)).toISOString().slice(0, 10);
})(); // next Monday (always a valid brief week)

// ------------------------------------------------------------ auth
await test('401 without bearer, bad token, revoked token; WWW-Authenticate Bearer', async () => {
  for (const r of [
    await mcpPOST(req(null, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })),
    await mcpGET(req(null, undefined, { method: 'GET' })),
    await mcpDELETE(req(null, undefined, { method: 'DELETE' })),
    await mcpPOST(req('fb_' + 'x'.repeat(43), { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })),
    await mcpPOST(req('not-a-token', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })),
  ]) {
    assert.equal(r.status, 401);
    assert.match(r.headers.get('www-authenticate') || '', /^Bearer\b/);
    assert.deepEqual(await r.json(), { error: 'unauthorized' });
  }
  const { token, record } = await createToken(store, { label: 'Revoked', scopes: ['board:read'] });
  await revokeToken(store, record.id);
  assert.equal((await mcpPOST(req(token, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }))).status, 401);
});

await test('middleware lets /api/mcp through to its own bearer auth', () => {
  assert.equal(bypassesFrameKey('/api/mcp'), true);
});

await test('413 on an oversized body before auth', async () => {
  const r = await mcpPOST(new Request('https://board.test/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(200 * 1024), authorization: `Bearer ${FULL}` }, body: '{}' }));
  assert.equal(r.status, 413);
});

// ------------------------------------------------------------ protocol
await test('initialize -> serverInfo, tools capability, instructions', async () => {
  const msg = await rpc(FULL, 'initialize', { protocolVersion: PROTO, capabilities: {}, clientInfo: { name: 'mcp-check', version: '1' } });
  assert.equal(msg.result.serverInfo.name, 'family-board');
  assert.ok(msg.result.capabilities.tools);
  assert.match(msg.result.instructions, /untrusted/);
  assert.match(msg.result.instructions, /stable "key"/);
  assert.match(msg.result.instructions, /review mode/);
});

const EXPECT = {
  get_board: { readOnlyHint: true, idempotentHint: true },
  add_shopping_items: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  update_shopping_item: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  remove_shopping_item: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  set_chores: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  publish_weekly_brief: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  list_changes: { readOnlyHint: true, idempotentHint: false },
  shopping_updates: { readOnlyHint: true, idempotentHint: false },
};

await test('tools/list -> the 7 contract tools + shopping_updates with schemas, annotations and guidance', async () => {
  const { result } = await rpc(FULL, 'tools/list');
  assert.deepEqual(result.tools.map((t) => t.name).sort(), Object.keys(EXPECT).sort());
  for (const t of result.tools) {
    assert.equal(t.inputSchema.type, 'object', t.name);
    for (const [k, v] of Object.entries(EXPECT[t.name])) assert.equal(t.annotations[k], v, `${t.name}.${k}`);
    assert.equal(t.annotations.openWorldHint, false, t.name);
    assert.ok(t.description.length > 60, t.name);
  }
  const by = Object.fromEntries(result.tools.map((t) => [t.name, t]));
  assert.match(by.get_board.description, /untrusted/);
  assert.match(by.list_changes.description, /untrusted/);
  assert.match(by.add_shopping_items.description, /stable key/);
  assert.match(by.add_shopping_items.description, /pending/);
  assert.match(by.publish_weekly_brief.description, /private/i);
  assert.match(by.publish_weekly_brief.description, /rejected/);
  assert.deepEqual(by.add_shopping_items.inputSchema.required, ['items']);
  assert.equal(by.add_shopping_items.inputSchema.properties.items.maxItems, 50);
  assert.equal(by.add_shopping_items.inputSchema.properties.items.items.properties.text.maxLength, 60);
  assert.deepEqual(by.publish_weekly_brief.inputSchema.required, ['week']);
  assert.equal(by.list_changes.inputSchema.required, undefined, 'since is optional (server cursor)');
  assert.match(by.shopping_updates.description, /start of a chat/);
});

// ------------------------------------------------------------ every tool
let milkId;
await test('get_board matches the REST view', async () => {
  const b = okResult(await call(FULL, 'get_board'), 'get_board');
  assert.ok(Number.isInteger(b.rev));
  assert.deepEqual(b.people.map((p) => p.id), ['nate', 'hayley', 'lilly', 'daisy']);
  const rest = await (await restBoard(new Request('https://board.test/api/agent/board', { headers: { authorization: `Bearer ${FULL}` } }))).json();
  assert.deepEqual(b, rest);
});

await test('add_shopping_items: created, then merged/unchanged by key (no duplicates)', async () => {
  const a = okResult(await call(FULL, 'add_shopping_items', { items: [{ key: 'wk:milk', text: 'Milk 2%', qty: 2, store: 'Costco' }, { text: 'Basil', confidence: 'suggest' }] }), 'add');
  assert.deepEqual(a.results.map((x) => x.status), ['created', 'created']);
  milkId = a.results[0].id;
  const again = okResult(await call(FULL, 'add_shopping_items', { items: [{ key: 'wk:milk', text: 'Milk 2%', qty: 2, store: 'Costco' }] }), 'add again');
  assert.equal(again.results[0].id, milkId);
  assert.equal(again.results[0].status, 'unchanged');
  const more = okResult(await call(FULL, 'add_shopping_items', { items: [{ key: 'wk:milk', text: 'Milk 2%', qty: 3, store: 'Costco' }] }), 'add more');
  assert.equal(more.results[0].status, 'merged');
});

await test('update_shopping_item + remove_shopping_item', async () => {
  const u = okResult(await call(FULL, 'update_shopping_item', { id: milkId, done: true }), 'update');
  assert.equal(u.status, 'updated');
  assert.equal(u.item.done, true);
  const b = okResult(await call(FULL, 'get_board'), 'get_board');
  const basil = b.shopping.items.find((i) => i.text === 'Basil');
  const r = okResult(await call(FULL, 'remove_shopping_item', { id: basil.id }), 'remove');
  assert.equal(r.status, 'removed');
  errResult(await call(FULL, 'remove_shopping_item', { id: basil.id }), 404);
});

await test('set_chores', async () => {
  const c = okResult(await call(FULL, 'set_chores', {
    scope: { person: 'lilly', routine: 'morning' },
    chores: [{ key: 'lilly:bed', person: 'lilly', routine: 'morning', title: 'Make bed', icon: '🛏️', stars: 1, recurrence: 'daily' }],
  }), 'set_chores');
  assert.equal(c.results[0].status, 'created');
  assert.deepEqual(c.removed, []);
});

let briefRev;
await test('publish_weekly_brief (+ If-Match 412 passthrough, private todo redacted)', async () => {
  const brief = {
    week: WEEK,
    headline: [{ key: 'lilly-out', person: 'lilly', text: 'Lilly out 10:55 daily' }],
    days: [{ date: WEEK, items: [{ key: 'funrun', kind: 'timed', time: '3:00', text: 'Fun Run', people: ['lilly'] }] }],
    decisions: [{ key: 'pickup', title: 'Who picks up Lilly?', when: { date: WEEK, time: '10:55' }, kind: 'ride', candidates: ['nate', { name: 'Kristin' }] }],
    todos: [{ key: 'dentist', text: 'Dentist for Daisy 3pm', owner: 'hayley' }],
    stillOpen: ['Nanny search'],
  };
  const p = okResult(await call(FULL, 'publish_weekly_brief', brief), 'publish');
  assert.equal(p.week, WEEK);
  briefRev = p.rev;
  const todo = p.brief.todos[0];
  assert.equal(todo.private, true);
  assert.ok(!JSON.stringify(p).includes('Dentist'), 'private text never leaves the server without private:read');
  errResult(await call(FULL, 'publish_weekly_brief', { ...brief, if_match_rev: briefRev - 1 }), 412);
  okResult(await call(FULL, 'publish_weekly_brief', { ...brief, if_match_rev: briefRev }), 'publish with fresh If-Match');
});

await test('list_changes', async () => {
  const c = okResult(await call(FULL, 'list_changes', { since: 0 }), 'list_changes');
  assert.ok(c.events.length >= 5);
  assert.ok(c.next >= briefRev);
  assert.ok(c.events.some((e) => e.section === 'brief'));
  const later = okResult(await call(FULL, 'list_changes', { since: c.next }), 'list_changes later');
  assert.equal(later.events.length, 0);
});

await test('list_changes without since uses the server cursor; section + peek', async () => {
  const t = await mk('Cursor bot');
  const first = okResult(await call(t, 'list_changes', {}), 'first');
  assert.ok(first.events.length >= 5, 'first call = last 7 days');
  assert.equal(first.cursor.first, true);
  const again = okResult(await call(t, 'list_changes', {}), 'again');
  assert.equal(again.events.length, 0, 'cursor advanced');
  const w = await mk('Family agent');
  okResult(await call(w, 'add_shopping_items', { items: [{ text: 'Cursor crackers' }] }), 'add');
  const peek = okResult(await call(t, 'list_changes', { peek: true, section: ['brief'] }), 'peek');
  assert.equal(peek.events.length, 0, 'section filter');
  const shop = okResult(await call(t, 'list_changes', { section: ['shopping'] }), 'shop');
  assert.ok(shop.events.some((e) => e.text === 'Cursor crackers' && e.actorLabel === 'Family agent'));
  assert.equal(okResult(await call(t, 'list_changes', {}), 'after').events.length, 0);
});

await test('shopping_updates: frame check-off as a sentence, own cursor, bare-token auth', async () => {
  const t = await mk('Grok bot', 'board:read,changes:read,shopping:write');
  okResult(await call(t, 'shopping_updates', {}), 'prime');
  const w = await mk('Family agent');
  const add = okResult(await call(w, 'add_shopping_items', { items: [{ text: 'Oat milk', qty: 2 }] }), 'add');
  const id = add.results[0].id;
  const fr = await framePOST(new Request('https://board.test/api/board', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://board.test' }, body: JSON.stringify({ ops: [{ op: 'shopping.toggle', id, done: true, by: 'lilly' }] }) }));
  assert.equal(fr.status, 200);
  const r = await call(t, 'shopping_updates', {});
  const d = okResult(r, 'shopping_updates');
  assert.ok(d.since_last_check.includes('Oat milk (2) was added by Family agent'), JSON.stringify(d.since_last_check));
  assert.ok(d.since_last_check.includes('Oat milk (2) was checked off on the frame by Lilly'));
  assert.ok(r.content[0].text.startsWith('Since your last check:'));
  assert.ok(Array.isArray(d.still_needed) && typeof d.counts.still_needed === 'number');
  assert.equal(okResult(await call(t, 'shopping_updates', {}), 'again').counts.changes, 0);
  // list_changes for the same token still sees those events (independent cursor)
  const lc = okResult(await call(t, 'list_changes', { section: ['shopping'] }), 'lc');
  assert.ok(lc.events.some((e) => e.id === id && e.op === 'done' && e.actor === 'frame' && e.doneBy === 'Lilly'));
  // bare token in Authorization (xAI `authorization` field may send it without "Bearer ")
  const res = await mcpPOST(new Request('https://board.test/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTO, authorization: t }, body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method: 'tools/list', params: {} }) }));
  assert.equal(res.status, 200);
});

// ------------------------------------------------------------ scopes, ownership, privacy, review, limits
await test('scope errors are tool errors (403 + scope), like REST', async () => {
  const READ = await mk('Reader', ['board:read']);
  okResult(await call(READ, 'get_board'), 'reader get_board');
  const cases = [
    ['add_shopping_items', { items: [{ text: 'Eggs' }] }, 'shopping:write'],
    ['update_shopping_item', { id: milkId, done: false }, 'shopping:write'],
    ['remove_shopping_item', { id: milkId }, 'shopping:write'],
    ['set_chores', { chores: [] }, 'chores:write'],
    ['publish_weekly_brief', { week: WEEK }, 'brief:write'],
    ['list_changes', { since: 0 }, 'changes:read'],
  ];
  for (const [name, args, scope] of cases) {
    const e = errResult(await call(READ, name, args), 403);
    assert.equal(e.error, 'forbidden');
    assert.equal(e.scope, scope, name);
  }
  const SHOP = await mk('Shopper', ['shopping:write']);
  errResult(await call(SHOP, 'get_board'), 403);
});

await test('ownership: another agent cannot remove or edit qty, but may check off', async () => {
  const OTHER = await mk('Other agent');
  const e = errResult(await call(OTHER, 'remove_shopping_item', { id: milkId }), 403);
  assert.equal(e.error, 'not-owner');
  errResult(await call(OTHER, 'update_shopping_item', { id: milkId, qty: 5 }), 403);
  okResult(await call(OTHER, 'update_shopping_item', { id: milkId, done: false }), 'other un-checks');
});

await test('privacy rejections pass through as 422 tool errors with details', async () => {
  const P = await mk('Privacy agent');
  for (const text of ['Zelle Kristin $150', 'mail hayley@example.com', 'Card 4111 1111 1111 1111', '<b>Milk</b>']) {
    const e = errResult(await call(P, 'add_shopping_items', { items: [{ text }] }), 422);
    assert.equal(e.error, 'invalid');
    assert.equal(e.details[0].path, 'items[0].text', text);
  }
  const e = errResult(await call(P, 'publish_weekly_brief', { week: WEEK, headline: ['Therapy Tuesday'] }), 422);
  assert.match(e.details[0].message, /sensitive/);
  const ch = errResult(await call(P, 'set_chores', { chores: [{ person: 'lilly', routine: 'morning', title: 'Dentist floss chart' }] }), 422);
  assert.equal(ch.details[0].path, 'chores[0].title');
});

await test('server-side validation the zod schema cannot express still answers 422', async () => {
  const V = await mk('Validator');
  errResult(await call(V, 'publish_weekly_brief', { week: '2026-10-13' }), 422); // a Tuesday
  errResult(await call(V, 'set_chores', { scope: { person: 'lilly' }, chores: [{ person: 'daisy', routine: 'morning', title: 'x' }] }), 422);
});

await test('input-schema violations are rejected before any write', async () => {
  const V = await mk('Schema agent');
  const before = (await store.read()).rev;
  for (const [name, args] of [
    ['add_shopping_items', { items: [] }],
    ['add_shopping_items', { items: [{ text: 'x'.repeat(61) }] }],
    ['add_shopping_items', { items: [{ text: 'Milk', key: 'bad key!' }] }],
    ['update_shopping_item', { id: '../etc', done: true }],
    ['set_chores', { chores: [{ person: 'bob', routine: 'morning', title: 'x' }] }],
    ['list_changes', { since: -1 }],
  ]) {
    const msg = await rpc(V, 'tools/call', { name, arguments: args });
    const rejected = msg.error || (msg.result && msg.result.isError);
    assert.ok(rejected, `${name} ${JSON.stringify(args)} should be rejected`);
  }
  assert.equal((await store.read()).rev, before);
});

await test('review-mode tokens create pending suggestions', async () => {
  const R = await mk('School email', ALL, 'review');
  const a = okResult(await call(R, 'add_shopping_items', { items: [{ key: 'r:eggs', text: 'Eggs' }] }), 'review add');
  assert.equal(a.results[0].status, 'pending');
  const c = okResult(await call(R, 'set_chores', { chores: [{ key: 'd:teeth', person: 'daisy', routine: 'evening', title: 'Brush teeth' }] }), 'review chores');
  assert.equal(c.status, 'pending');
  const b = okResult(await call(R, 'publish_weekly_brief', { week: WEEK, notes: ['Picture day Friday'] }), 'review brief');
  assert.equal(b.status, 'pending');
  const r = await call(R, 'add_shopping_items', { items: [{ key: 'r:eggs', text: 'Eggs' }] });
  assert.match(r.content[0].text, /pending/i);
  const board = okResult(await call(FULL, 'get_board'), 'get_board');
  assert.ok(board.pending.length >= 3);
  assert.ok(!board.shopping.items.some((i) => i.text === 'Eggs'), 'not applied until approved');
});

await test('idempotency_key replays the stored result; reuse with other args is 422', async () => {
  const I = await mk('Idem agent');
  const one = okResult(await call(I, 'add_shopping_items', { items: [{ text: 'Bread' }], idempotency_key: 'run-1' }), 'idem 1');
  const two = okResult(await call(I, 'add_shopping_items', { items: [{ text: 'Bread' }], idempotency_key: 'run-1' }), 'idem 2');
  assert.deepEqual(one, two);
  errResult(await call(I, 'add_shopping_items', { items: [{ text: 'Butter' }], idempotency_key: 'run-1' }), 422);
});

await test('rate limit: 11th write in a minute -> 429 tool error with retryAfter; reads unaffected', async () => {
  const L = await mk('Busy agent');
  for (let i = 0; i < 10; i++) okResult(await call(L, 'add_shopping_items', { items: [{ key: `rl:${i}`, text: `Item ${i}` }] }), `write ${i}`);
  const e = errResult(await call(L, 'add_shopping_items', { items: [{ text: 'One too many' }] }), 429);
  assert.ok(e.retryAfter >= 1);
  assert.match((await call(L, 'add_shopping_items', { items: [{ text: 'Again' }] })).content[0].text, /Retry after/);
  okResult(await call(L, 'get_board'), 'reads are not rate limited');
});

await test('BOARD_DEV_TOKEN works against the in-memory store', async () => {
  const b = okResult(await call(process.env.BOARD_DEV_TOKEN, 'get_board'), 'dev get_board');
  assert.ok(Number.isInteger(b.rev));
  process.env.VERCEL = '1';
  try {
    assert.equal((await mcpPOST(req(process.env.BOARD_DEV_TOKEN, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }))).status, 401);
  } finally {
    delete process.env.VERCEL;
  }
});

await test('stateless: GET (no SSE session) is not served', async () => {
  const r = await mcpGET(req(FULL, undefined, { method: 'GET', headers: { accept: 'text/event-stream' } }));
  assert.ok([405, 400].includes(r.status), `GET -> ${r.status}`);
});

console.log(`${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
