// Checks for the family board backend (lib/board, api/board.js, api/agent/*, middleware).
// Plain node, no deps, no network:  node scripts/board-check.mjs
import assert from 'node:assert/strict';

const ENV = ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'VERCEL', 'FRAME_KEY', 'BOARD_DEV_TOKEN', 'BOARD_DEV_MODE', 'BOARD_STORE'];
function env(vars = {}) {
  for (const k of ENV) delete process.env[k];
  Object.assign(process.env, { BOARD_TZ: 'America/Chicago' }, vars);
}
env();

const { classify, validateShoppingAdd, validateBriefPut, validateChoresPut, validateFrameOps, Checker, ValidationError, luhn } = await import('../lib/board/schema.js');
const ops = await import('../lib/board/ops.js');
const { boardView, briefView } = await import('../lib/board/redact.js');
const { createMemoryStore, setStore, getStore } = await import('../lib/board/store.js');
const { createToken, revokeToken, resolveToken, hashToken, TOKEN_RE } = await import('../lib/board/tokens.js');
const { seedFromFixture } = await import('../lib/board/seed.js');
const { GET: boardGET, POST: boardPOST } = await import('../api/board.js');
const { GET: agentBoard } = await import('../api/agent/board.js');
const { POST: shopPOST } = await import('../api/agent/shopping/items.js');
const { PATCH: itemPATCH, DELETE: itemDELETE } = await import('../api/agent/shopping/items/[id].js');
const { PUT: choresPUT } = await import('../api/agent/chores.js');
const { PUT: briefPUT } = await import('../api/agent/brief/[week].js');
const { GET: changesGET } = await import('../api/agent/changes.js');
const { GET: openapiGET } = await import('../api/agent/openapi.js');
const { GET: openapiJsonGET } = await import('../api/agent/openapi.json.js');
const { default: middleware, bypassesFrameKey } = await import('../middleware.js');
const { GET: shopUpdatesGET } = await import('../api/agent/shopping/updates.js');
const { collapseEvents, listChanges, shoppingSentence } = await import('../lib/board/changes.js');
const { cursorKey, createRedisStore } = await import('../lib/board/store.js');

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

const NOW = new Date('2026-10-13T14:00:00Z'); // Tue Oct 13, 09:00 in Chicago
const WEEK = '2026-10-12';
const agentA = { agent: 'a_agentaaa', label: 'Grocery agent' };
const agentB = { agent: 'a_agentbbb', label: 'Meal planner' };
const ctxFor = (actor, extra = {}) => ops.makeCtx({ actor, now: NOW, ...extra });
const invalid = (fn) => assert.throws(fn, (e) => e instanceof ValidationError && e.details.length > 0);

// ------------------------------------------------------------ schema / privacy
await test('privacy: Oct 12 samples', () => {
  const chase = classify('Chase fraud alert: card ending 4825 — call to verify the charge');
  assert.equal(chase.reject, null);
  assert.equal(chase.private, true, 'Chase fraud alert -> private');
  assert.equal(classify('Zelle request from Kristin $150').private, true, 'Zelle $150 -> private');
  assert.equal(classify('Venmo Kristin for the week').private, true);
  const phone = classify('Call Kristin 414-559-8707 about Friday');
  assert.equal(phone.private, false);
  assert.ok(phone.text.includes('xxx-xxx-8707') && !phone.text.includes('414-559'), phone.text);
  assert.ok(classify('(414) 559-8707').text.endsWith('8707') && !classify('(414) 559-8707').text.includes('559'));
  assert.ok(!classify('+1 414 559 8707').text.includes('414 559'));
  assert.equal(classify('Bay Psych 12:30 (Hayley)').private, true, 'Bay Psych -> private');
  assert.equal(classify('Verification code 123456').private, true);
  assert.equal(classify('Dentist 3pm').private, true);
  assert.equal(classify('Custody hearing').private, true);
  assert.equal(classify('Pay 20 USD for field trip').private, true);
});

await test('privacy: rejects, plain text, harmless text', () => {
  assert.equal(classify('Card 4111 1111 1111 1111').reject, 'card-number');
  assert.equal(classify('4111-1111-1111-1111').reject, 'card-number');
  assert.equal(classify('Account 12345678 overdue').reject, 'account-number');
  assert.equal(classify('mail hayley@example.com').reject, 'email-address');
  assert.equal(classify('<b>bold</b>').reject, 'html');
  assert.equal(classify('<script>x</script>').reject, 'html');
  assert.ok(luhn('4111111111111111') && !luhn('4111111111111112'));
  for (const ok of ['Milk 2%', 'Dr Pepper', 'Pinto beans', 'Lilly: Music', 'Fun Run 3:00', '2026-10-12 note', 'Eggs x12']) {
    const c = classify(ok);
    assert.equal(c.reject, null, ok);
    assert.equal(c.private, false, ok);
  }
  assert.equal(classify('Mi\u200Blk\u202E \u2066x\u2069\u0007').text, 'Milk x');
  assert.equal(classify('Café   au\n\tlait').text, 'Café au lait');
});

await test('schema: shopping/who/icon/link/limits', () => {
  const { items } = validateShoppingAdd({ items: [{ key: 'k:1', text: '  Milk 2% ', qty: 2, store: 'Costco', confidence: 'suggest' }] });
  assert.deepEqual(items[0], { key: 'k:1', text: 'Milk 2%', qty: 2, store: 'Costco', category: null, note: '', suggested: true });
  invalid(() => validateShoppingAdd({ items: [{ text: 'x'.repeat(61) }] }));
  invalid(() => validateShoppingAdd({ items: [{ text: 'Zelle Kristin $150' }] }));
  invalid(() => validateShoppingAdd({ items: [{ text: 'Milk', qty: 0 }] }));
  invalid(() => validateShoppingAdd({ items: [{ text: 'Milk', key: 'bad key!' }] }));
  invalid(() => validateShoppingAdd({ items: [] }));
  invalid(() => validateShoppingAdd({ items: Array.from({ length: 51 }, () => ({ text: 'a' })) }));
  const c = new Checker();
  assert.deepEqual(c.who('nate', 'w'), { person: 'nate' });
  assert.deepEqual(c.who({ name: 'Hayley' }, 'w'), { person: 'hayley' });
  assert.deepEqual(c.who({ name: 'Kristin' }, 'w'), { name: 'Kristin' });
  assert.equal(c.who(null, 'w'), null);
  assert.ok(c.ok);
  c.who('bob', 'w');
  c.who({ person: 'bob' }, 'w');
  c.who({ name: 'x'.repeat(25) }, 'w');
  assert.equal(c.errors.length, 3);
  assert.match(c.errors[1].message, /nate, hayley, lilly, daisy/);
  const i = new Checker();
  assert.equal(i.icon('🛏️', 'i'), '🛏️');
  assert.equal(i.icon('👨\u200D👩\u200D👧', 'i'), '👨\u200D👩\u200D👧');
  assert.equal(i.icon('star', 'i'), 'star');
  assert.ok(i.ok);
  i.icon('<img src=x>', 'i');
  i.icon('ab', 'i');
  i.icon('🛏️🛏️', 'i');
  assert.equal(i.errors.length, 3);
  const l = new Checker();
  assert.deepEqual(l.link({ url: 'https://richards.pledgestar.com/x?y=1', label: 'Pledgestar' }, 'l'), { host: 'richards.pledgestar.com', label: 'Pledgestar' });
  assert.deepEqual(l.link('https://Example.com/a', 'l'), { host: 'example.com', label: 'example.com' });
  assert.ok(l.ok);
  l.link('http://example.com', 'l');
  l.link('https://u:p@example.com', 'l');
  l.link('javascript:alert(1)', 'l');
  l.link('https://example.com/' + 'a'.repeat(200), 'l');
  assert.equal(l.errors.length, 4);
});

await test('schema: chores + frame ops', () => {
  const { scope, chores } = validateChoresPut({ scope: { person: 'lilly', routine: 'morning' }, chores: [{ person: 'lilly', routine: 'morning', title: 'Make bed', icon: '🛏️', stars: 1, recurrence: 'daily' }] });
  assert.deepEqual(scope, { person: 'lilly', routine: 'morning' });
  assert.match(chores[0].key, /^auto:[0-9a-f]{16}$/, 'auto keys are opaque');
  invalid(() => validateChoresPut({ scope: { person: 'lilly' }, chores: [{ person: 'daisy', routine: 'morning', title: 'x' }] }));
  invalid(() => validateChoresPut({ chores: [{ person: 'lilly', routine: 'noon', title: 'x' }] }));
  invalid(() => validateChoresPut({ chores: [{ person: 'lilly', routine: 'morning', title: 'x', stars: 4 }] }));
  invalid(() => validateChoresPut({ chores: [{ person: 'lilly', routine: 'morning', title: 'x', icon: '<b>' }] }));
  const v = validateFrameOps([{ op: 'shopping.add', text: 'Milk' }, { op: 'chore.done', id: 'c_abcdefgh', by: 'lilly' }]);
  assert.deepEqual(v[1], { op: 'chore.done', id: 'c_abcdefgh', by: { person: 'lilly' }, done: true });
  assert.throws(() => validateFrameOps([{ op: 'nope' }]), (e) => e.status === 400);
  assert.throws(() => validateFrameOps([{ op: 'shopping.toggle', id: '../x', done: true }]), (e) => e.status === 400);
  assert.throws(() => validateFrameOps([{ op: 'shopping.toggle', id: 's_abcdefgh' }]), (e) => e.status === 400);
});

const BRIEF = () => ({
  title: 'October 12–18',
  headline: [{ key: 'lilly-out', person: 'lilly', text: 'Lilly out 10:55 daily' }, 'Fun Run Thursday'],
  days: [
    { date: '2026-10-13', care: { who: { name: 'Kristin' }, needed: true }, items: [{ key: 'pickup', kind: 'timed', time: '10:55', text: 'Lilly pickup', people: ['lilly'], decision: 'tue-pickup' }] },
    { date: '2026-10-14', items: [{ key: 'therapy', kind: 'timed', time: '12:30', text: 'Hayley appointment', place: 'Bay Psych', people: ['hayley'] }] },
    { date: '2026-10-15', specials: [{ person: 'lilly', text: 'Music' }], items: [{ key: 'funrun', kind: 'timed', time: '3:00', text: 'Lilly back at school for Fun Run' }] },
  ],
  decisions: [
    { key: 'tue-pickup', title: 'Who picks up Lilly?', context: 'Kristin starts 11:30', when: { date: '2026-10-13', time: '10:55' }, kind: 'ride', candidates: ['nate', 'hayley', { name: 'Kristin' }] },
    { key: 'fri-care', title: 'Friday care', when: { date: '2026-10-16' }, kind: 'care', slots: [{ key: 'am', label: 'Morning' }, { key: 'pm', label: 'Afternoon' }] },
  ],
  todos: [
    { key: 'pledgestar', text: 'Enter Lilly on Pledgestar', due: '2026-10-16', link: { url: 'https://richards.pledgestar.com', label: 'Pledgestar' } },
    { key: 'chase', text: 'Chase fraud alert: card ending 4825', owner: 'hayley' },
    { key: 'zelle', text: 'Zelle Kristin $150' },
    { key: 'call', text: 'Call 414-559-8707 re: nanny' },
  ],
  stillOpen: [{ key: 'nanny', text: 'Nanny search' }],
  comingUp: [{ key: 'hendrix', date: '2026-10-24', time: '10:30–12:30', text: "Hendrix's 2nd birthday", place: 'Lindner Pumpkin Farm' }],
  notes: ['Picture day moved'],
});

await test('schema: brief validation + privacy', () => {
  const d = validateBriefPut(WEEK, BRIEF());
  assert.equal(d.days.length, 7);
  assert.equal(d.days[0].date, WEEK);
  assert.equal(d.days[6].date, '2026-10-18');
  const todo = (k) => d.todos.find((t) => t.key === k);
  assert.equal(todo('chase').private, true);
  assert.equal(todo('zelle').private, true);
  assert.equal(todo('pledgestar').private, false);
  assert.deepEqual(todo('pledgestar').link, { host: 'richards.pledgestar.com', label: 'Pledgestar' });
  assert.ok(todo('call').text.includes('xxx-xxx-8707'));
  assert.equal(d.days[2].items[0].private, true, 'Bay Psych place -> private');
  assert.equal(d.decisions[0].slots.length, 1);
  assert.deepEqual(d.decisions[0].candidates, [{ person: 'nate' }, { person: 'hayley' }, { name: 'Kristin' }]);
  invalid(() => validateBriefPut('2026-10-13', BRIEF())); // not a Monday
  invalid(() => validateBriefPut(WEEK, { ...BRIEF(), headline: ['Zelle $150 to Kristin'] }));
  invalid(() => validateBriefPut(WEEK, { ...BRIEF(), todos: [{ text: 'Pay card 4111111111111111' }] }));
  invalid(() => validateBriefPut(WEEK, { ...BRIEF(), days: [{ date: '2026-10-20' }] }));
  invalid(() => validateBriefPut(WEEK, { ...BRIEF(), days: [{ date: WEEK, items: [{ text: 'x', decision: 'nope' }] }] }));
  invalid(() => validateBriefPut(WEEK, { ...BRIEF(), todos: [{ key: 'a', text: 'x' }, { key: 'a', text: 'y' }] }));
  invalid(() => validateBriefPut(WEEK, { ...BRIEF(), todos: [{ text: 'x', owner: 'kristin' }] }));
});

// ------------------------------------------------------------ ops
await test('ops: shopping merge, need-at-least, keys, suggestions', () => {
  const doc = ops.emptyDoc();
  const a = ctxFor(agentA);
  const add = (it) => ops.addShoppingItem(doc, { qty: 1, store: null, suggested: false, ...it }, a);
  const r1 = add({ text: 'Milk', qty: 1 });
  assert.equal(r1.status, 'created');
  assert.match(r1.id, /^s_[a-z0-9]{8}$/);
  assert.equal(add({ text: 'milk!', qty: 3 }).status, 'merged');
  assert.equal(doc.shopping.items.length, 1);
  assert.equal(doc.shopping.items[0].qty, 3);
  assert.equal(add({ text: 'MILK', qty: 2 }).status, 'unchanged', 'need at least N never lowers or doubles');
  assert.equal(add({ text: 'Milk', store: 'Costco' }).status, 'merged', 'store filled in');
  assert.equal(add({ text: 'Milk', store: 'Target' }).status, 'created', 'other store = other item');
  const k = add({ key: 'wk42:eggs', text: 'Eggs', qty: 2 });
  assert.equal(add({ key: 'wk42:eggs', text: 'Eggs', qty: 2 }).status, 'unchanged');
  ops.updateShoppingItem(doc, k.id, { done: true }, ctxFor(ops.FRAME_ACTOR));
  assert.equal(add({ key: 'wk42:eggs', text: 'Eggs', qty: 2 }).status, 'unchanged', 'bought item not resurrected');
  assert.equal(doc.shopping.items.filter((x) => x.text === 'Eggs').length, 1);
  const s = add({ text: 'Basil', suggested: true });
  assert.equal(doc.shopping.items.find((x) => x.id === s.id).suggested, true);
  assert.equal(add({ text: 'basil' }).status, 'merged');
  assert.equal(doc.shopping.items.find((x) => x.id === s.id).suggested, false, 'confirmed by a sure add');
  const item = doc.shopping.items.find((x) => x.id === r1.id);
  assert.deepEqual(item.addedBy, agentA);
  assert.equal(item.addedAt, NOW.toISOString());
  // ownership
  assert.throws(() => ops.updateShoppingItem(doc, r1.id, { qty: 5 }, ctxFor(agentB)), (e) => e.status === 403);
  assert.equal(ops.updateShoppingItem(doc, r1.id, { done: true }, ctxFor(agentB)).status, 'updated');
  assert.throws(() => ops.removeShoppingItem(doc, r1.id, ctxFor(agentB)), (e) => e.status === 403);
  assert.throws(() => ops.removeShoppingItem(doc, 's_zzzzzzzz', ctxFor(agentA)), (e) => e.status === 404);
});

await test('ops: review mode -> pending -> approve/dismiss', () => {
  const doc = ops.emptyDoc();
  const r = ctxFor(agentA, { mode: 'review' });
  const [res] = ops.agentAddShopping(doc, [{ key: 'k1', text: 'Apples', qty: 2, suggested: false }], r);
  assert.equal(res.status, 'pending');
  assert.match(res.id, /^p_/);
  assert.equal(doc.shopping.items.length, 0);
  assert.equal(doc.pending.length, 1);
  const [again] = ops.agentAddShopping(doc, [{ key: 'k1', text: 'Apples', qty: 2, suggested: false }], r);
  assert.equal(again.id, res.id, 'replay dedupes in the queue');
  assert.equal(doc.pending.length, 1);
  ops.agentAddShopping(doc, [{ text: 'Pears', qty: 1, suggested: false }], r);
  const view = boardView(doc, { today: '2026-10-13', week: WEEK });
  assert.deepEqual(Object.keys(view.pending[0]).sort(), ['at', 'id', 'op', 'section', 'source', 'summary']);
  assert.equal(view.pending[0].summary, 'Add Apples ×2');
  const f = ctxFor(ops.FRAME_ACTOR);
  ops.applyFrameOps(doc, [{ op: 'pending.approve', id: res.id }, { op: 'pending.dismiss', id: doc.pending[1].id }], f);
  assert.equal(doc.pending.length, 0);
  assert.equal(doc.shopping.items.length, 1);
  assert.deepEqual(doc.shopping.items[0].addedBy, agentA, 'approved item keeps agent provenance');
  assert.throws(() => ops.applyFrameOps(doc, [{ op: 'pending.approve', id: res.id }], f), (e) => e.status === 409);
  // non-shopping writes in review mode
  const out = ops.agentPublishBrief(doc, validateBriefPut(WEEK, BRIEF()), r);
  assert.equal(out.status, 'pending');
  assert.equal(doc.briefs[WEEK], undefined);
  ops.approvePending(doc, out.pending, f);
  assert.equal(doc.briefs[WEEK].source.label, 'Grocery agent');
});

await test('ops: chores scoped replace, done state, retire', () => {
  const doc = ops.emptyDoc();
  const a = ctxFor(agentA);
  const b = ctxFor(agentB);
  const set = (ctx, scope, list) => ops.setChores(doc, validateChoresPut({ scope, chores: list }), ctx);
  const ch = (title, extra = {}) => ({ person: 'lilly', routine: 'morning', title, ...extra });
  const r1 = set(a, { person: 'lilly', routine: 'morning' }, [ch('Make bed', { key: 'bed' }), ch('Brush teeth', { key: 'teeth' })]);
  assert.deepEqual(r1.results.map((x) => x.status), ['created', 'created']);
  set(b, { person: 'lilly' }, [ch('Feed fish', { key: 'fish' }), { person: 'lilly', routine: 'evening', title: 'Pack bag', key: 'bag' }]);
  assert.equal(doc.chores.items.length, 4);
  const teeth = r1.results[1].id;
  ops.markChore(doc, { id: r1.results[0].id, by: { person: 'lilly' }, done: true }, ctxFor(ops.FRAME_ACTOR));
  const r2 = set(a, { person: 'lilly', routine: 'morning' }, [ch('Make your bed', { key: 'bed' })]);
  assert.equal(r2.results[0].id, r1.results[0].id, 'same key -> same id');
  assert.equal(r2.results[0].status, 'updated');
  assert.deepEqual(r2.removed, [teeth]);
  assert.equal(doc.chores.items.length, 3, "agent B's chores untouched");
  const view = boardView(doc, { today: '2026-10-13', week: WEEK });
  const bed = view.chores.items.find((x) => x.id === r1.results[0].id);
  assert.deepEqual(bed.doneToday.by, { person: 'lilly' });
  assert.equal(bed.title, 'Make your bed');
  // dropped-but-done chores stay until the next day
  set(a, { person: 'lilly', routine: 'morning' }, []);
  assert.ok(boardView(doc, { today: '2026-10-13', week: WEEK }).chores.items.some((x) => x.id === bed.id));
  ops.rollover(doc, ops.makeCtx({ now: new Date('2026-10-14T14:00:00Z') }));
  assert.ok(!doc.chores.items.some((x) => x.id === bed.id));
  assert.equal(boardView(doc, { today: '2026-10-14', week: WEEK }).chores.items.every((x) => x.doneToday === null), true, 'daily done state is per date');
});

await test('ops: brief ids, republish keeps who/done/owner/dismissed, stale, If-Match', () => {
  const doc = ops.emptyDoc();
  const a = ctxFor(agentA);
  const f = ctxFor(ops.FRAME_ACTOR);
  const draft = validateBriefPut(WEEK, BRIEF());
  ops.publishBrief(doc, draft, a);
  doc.rev = 5;
  const b1 = doc.briefs[WEEK];
  const pickup = b1.decisions.find((d) => d.key === 'tue-pickup');
  const fri = b1.decisions.find((d) => d.key === 'fri-care');
  const pledge = b1.todos.find((t) => t.key === 'pledgestar');
  const zelle = b1.todos.find((t) => t.key === 'zelle');
  for (const x of [pickup, fri, pledge, ...fri.slots]) assert.match(x.id, /^[a-z]_[a-z0-9]{8}$/);
  assert.equal(b1.days[1].items[0].decision, pickup.id, 'decision key -> id');
  ops.applyFrameOps(doc, [
    { op: 'brief.assign', decision: pickup.id, slot: pickup.slots[0].id, who: { person: 'nate' } },
    { op: 'brief.assign', decision: fri.id, slot: fri.slots[0].id, who: { name: 'Kristin' } },
    { op: 'brief.todo', id: pledge.id, done: true },
    { op: 'brief.owner', id: pledge.id, owner: { person: 'hayley' } },
    { op: 'brief.dismiss', kind: 'todo', id: zelle.id, reason: 'paid' },
  ], f);
  assert.equal(doc.briefs[WEEK].decisions[0].done, true);
  assert.equal(doc.briefs[WEEK]._rev, 6);
  assert.throws(() => ops.publishBrief(doc, draft, a, { ifMatch: 5 }), (e) => e.status === 412);
  doc.rev = 6;
  // republish: drop fri-care (answered) and add a todo; change pickup context.
  const next = BRIEF();
  next.decisions = [{ ...next.decisions[0], context: 'Kristin starts 11:45' }];
  next.todos.push({ key: 'library', text: 'Library books due' });
  ops.publishBrief(doc, validateBriefPut(WEEK, next), a, { ifMatch: 6 });
  const b2 = doc.briefs[WEEK];
  const p2 = b2.decisions.find((d) => d.key === 'tue-pickup');
  assert.equal(p2.id, pickup.id, 'stable id');
  assert.equal(p2.context, 'Kristin starts 11:45');
  assert.deepEqual(p2.slots[0].who, { person: 'nate' }, 'frame who kept');
  assert.equal(p2.done, true);
  const f2 = b2.decisions.find((d) => d.key === 'fri-care');
  assert.equal(f2.stale, true, 'answered + dropped -> stale');
  assert.deepEqual(f2.slots[0].who, { name: 'Kristin' });
  const t2 = b2.todos.find((t) => t.key === 'pledgestar');
  assert.equal(t2.done, true);
  assert.deepEqual(t2.owner, { person: 'hayley' });
  assert.ok(b2.todos.find((t) => t.key === 'zelle').dismissed, 'dismissed kept');
  // views
  const fv = briefView(b2, { audience: 'frame' });
  assert.ok(!fv.todos.some((t) => t.id === zelle.id), 'frame hides dismissed');
  const chase = fv.todos.find((t) => t.id === b2.todos.find((x) => x.key === 'chase').id);
  assert.equal(chase.text, 'Private item');
  assert.equal(chase.key, undefined);
  assert.deepEqual(chase.owner, { person: 'hayley' });
  const therapy = fv.days[2].items[0];
  assert.equal(therapy.text, 'Private appointment');
  assert.equal(therapy.place, undefined);
  assert.equal(therapy.time, '12:30');
  assert.ok(!JSON.stringify(fv).includes('Bay Psych') && !JSON.stringify(fv).includes('4825') && !JSON.stringify(fv).includes('Zelle'));
  assert.ok(!JSON.stringify(fv).includes('_set'));
  const av = briefView(b2, { audience: 'agent', reveal: true });
  assert.equal(av.days[2].items[0].place, 'Bay Psych');
  assert.ok(av.todos.some((t) => t.id === zelle.id && t.dismissed));
  // week window
  assert.throws(() => ops.publishBrief(doc, validateBriefPut('2026-12-07', {}), a), (e) => e.status === 422);
  // gone ids from the frame -> 409
  assert.throws(() => ops.applyFrameOps(doc, [{ op: 'brief.todo', id: 't_zzzzzzzz', done: true }], f), (e) => e.status === 409);
  assert.throws(() => ops.applyFrameOps(doc, [{ op: 'shopping.toggle', id: 's_zzzzzzzz', done: true }], f), (e) => e.status === 409);
});

// ------------------------------------------------------------ store
await test('store: CAS, no-op writes, lost race retries, conflict after retries', async () => {
  const store = createMemoryStore();
  const r1 = await store.apply((doc, ev) => { doc.shopping.items.push({ id: 's_aaaaaaaa' }); ev.push({ section: 'shopping', op: 'add', summary: 'a' }); });
  assert.equal(r1.rev, 1);
  const r2 = await store.apply(() => 'nothing');
  assert.equal(r2.changed, false);
  assert.equal(r2.rev, 1, 'no-op does not bump rev');
  let fired = 0;
  store.hooks.beforeCas = async () => {
    store.hooks.beforeCas = null;
    fired++;
    await store.apply((doc, ev) => { doc.shopping.items.push({ id: 's_bbbbbbbb' }); ev.push({ section: 'shopping', op: 'add', summary: 'b' }); });
  };
  let calls = 0;
  const r3 = await store.apply((doc, ev) => { calls++; doc.shopping.items.push({ id: 's_cccccccc' }); ev.push({ section: 'shopping', op: 'add', summary: 'c' }); });
  assert.equal(fired, 1);
  assert.equal(calls, 2, 're-applied on the fresh doc');
  assert.equal(r3.attempts, 2);
  assert.equal(r3.rev, 3);
  const { doc } = await store.read();
  assert.deepEqual(doc.shopping.items.map((x) => x.id), ['s_aaaaaaaa', 's_bbbbbbbb', 's_cccccccc'], 'both writes survive');
  const ch = await store.changes(1);
  assert.deepEqual(ch.events.map((e) => [e.rev, e.summary]), [[2, 'b'], [3, 'c']]);
  store.hooks.beforeCas = async () => {
    const h = store.hooks.beforeCas;
    store.hooks.beforeCas = null;
    await store.apply((d) => { d.day = String(Math.random()); });
    store.hooks.beforeCas = h;
  };
  await assert.rejects(store.apply((d) => { d.shopping.items = []; }), (e) => e.status === 409 && e.error === 'conflict');
  store.hooks.beforeCas = null;
});

await test('store: idempotency + rate counters + seed', async () => {
  const store = createMemoryStore();
  assert.equal(await store.idemPut('a_x', 'k', { v: 1 }, 60), true);
  assert.equal(await store.idemPut('a_x', 'k', { v: 2 }, 60), false, 'SET NX');
  assert.deepEqual(await store.idemGet('a_x', 'k'), { v: 1 });
  assert.equal(await store.idemGet('a_y', 'k'), null, 'per token');
  const t = Date.UTC(2026, 9, 13, 14, 0, 30);
  let r;
  for (let i = 0; i < 3; i++) r = await store.rateHit('a_x', t);
  assert.equal(r.minute, 3);
  assert.equal((await store.rateHit('a_x', t + 60000)).minute, 1, 'new minute window');
  const seeded = seedFromFixture({
    shopping: { items: [{ id: 's_seed0001', text: 'Milk', qty: 1 }] },
    chores: { items: [{ id: 'c_seed0001', person: 'lilly', routine: 'morning', title: 'Bed', icon: 'star', doneToday: { by: { person: 'lilly' }, at: 'x' } }] },
    brief: { week: WEEK, title: 'October 12–18', decisions: [{ id: 'd_seed0001', title: 'Pickup', slots: [{ id: 'l_seed0001', label: 'Who', who: null }] }] },
  }, NOW);
  const v = boardView(seeded, { today: '2026-10-13', week: WEEK });
  assert.equal(v.shopping.items[0].text, 'Milk');
  assert.deepEqual(v.chores.items[0].doneToday.by, { person: 'lilly' });
  assert.equal(v.brief.decisions[0].id, 'd_seed0001');
});

// ------------------------------------------------------------ REST
const ORIGIN = 'http://localhost:5173';
function req(method, path, { token, body, headers = {}, raw = false } = {}) {
  const h = new Headers(headers);
  if (token) h.set('authorization', `Bearer ${token}`);
  let b;
  if (body !== undefined) {
    b = raw ? body : JSON.stringify(body);
    if (!h.has('content-type')) h.set('content-type', 'application/json');
  }
  return new Request(ORIGIN + path, { method, headers: h, body: b });
}
const read = async (r) => ({ status: r.status, body: r.status === 304 ? null : await r.json(), headers: r.headers });

const store = createMemoryStore();
setStore(store);
// The rate limiter has its own test below; elsewhere it would trip on the volume of test writes.
const realRateHit = store.rateHit;
store.rateHit = async () => ({ minute: 1, hour: 1, resetMinute: 0, resetHour: 0 });
const mk = async (label, scopes, mode = 'direct') => (await createToken(store, { label, scopes, mode })).token;
const ALL = 'board:read,shopping:write,chores:write,brief:write,changes:read';
const tGrocery = await mk('Grocery agent', ALL);
const tReader = await mk('Reader', 'board:read');
const tPrivate = await mk('Owner', 'board:read,private:read');
const tReview = await mk('School email', 'shopping:write,brief:write,chores:write', 'review');
const tOther = await mk('Meal planner', 'shopping:write');

await test('tokens: format, hash-only storage, revoke', async () => {
  assert.match(tGrocery, TOKEN_RE);
  const recs = await store.tokenList();
  assert.ok(!JSON.stringify(recs).includes(tGrocery), 'token itself never stored');
  assert.ok(await store.tokenGet(hashToken(tGrocery)));
  const t = await mk('Temp', 'board:read');
  const rec = await resolveToken(store, `Bearer ${t}`);
  assert.equal(rec.label, 'Temp');
  await revokeToken(store, rec.id);
  assert.equal(await resolveToken(store, `Bearer ${t}`), null);
  assert.equal((await agentBoard(req('GET', '/api/agent/board', { token: t }))).status, 401);
  await assert.rejects(createToken(store, { label: 'x', scopes: 'board:write' }), /unknown scope/);
});

await test('REST: auth errors 401/403', async () => {
  let r = await read(await agentBoard(req('GET', '/api/agent/board')));
  assert.equal(r.status, 401);
  assert.match(r.headers.get('www-authenticate'), /^Bearer/);
  r = await read(await agentBoard(req('GET', '/api/agent/board', { token: 'fb_' + 'x'.repeat(43) })));
  assert.equal(r.status, 401);
  r = await read(await shopPOST(req('POST', '/api/agent/shopping/items', { token: tReader, body: { items: [{ text: 'Milk' }] } })));
  assert.equal(r.status, 403);
  assert.equal(r.body.scope, 'shopping:write');
  r = await read(await changesGET(req('GET', '/api/agent/changes?since=0', { token: tReader })));
  assert.equal(r.status, 403);
});

await test('REST: body checks 415/413/400/422', async () => {
  let r = await shopPOST(req('POST', '/api/agent/shopping/items', { token: tGrocery, body: '{"items":[]}', raw: true, headers: { 'content-type': 'text/plain' } }));
  assert.equal(r.status, 415);
  r = await shopPOST(req('POST', '/api/agent/shopping/items', { token: tGrocery, body: JSON.stringify({ items: [{ text: 'a', note: 'x'.repeat(17000) }] }), raw: true }));
  assert.equal(r.status, 413);
  r = await shopPOST(req('POST', '/api/agent/shopping/items', { token: tGrocery, body: '{nope', raw: true }));
  assert.equal(r.status, 400);
  const v = await read(await shopPOST(req('POST', '/api/agent/shopping/items', { token: tGrocery, body: { items: [{ text: 'Card 4111 1111 1111 1111' }, { text: '' }] } })));
  assert.equal(v.status, 422);
  assert.equal(v.body.error, 'invalid');
  assert.deepEqual(v.body.details.map((d) => d.path), ['items[0].text', 'items[1].text']);
  assert.equal(v.headers.get('cache-control'), 'no-store');
});

let milkId;
await test('REST: shopping add/merge/idempotency/patch/delete', async () => {
  const body = { items: [{ key: 'wk42:milk', text: 'Milk 2%', qty: 2, store: 'Costco' }, { text: 'Basil', confidence: 'suggest' }] };
  let r = await read(await shopPOST(req('POST', '/api/agent/shopping/items', { token: tGrocery, body, headers: { 'Idempotency-Key': 'run-1' } })));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.results.map((x) => x.status), ['created', 'created']);
  milkId = r.body.results[0].id;
  const replay = await read(await shopPOST(req('POST', '/api/agent/shopping/items', { token: tGrocery, body, headers: { 'Idempotency-Key': 'run-1' } })));
  assert.equal(replay.headers.get('idempotent-replayed'), 'true');
  assert.deepEqual(replay.body, r.body);
  r = await read(await shopPOST(req('POST', '/api/agent/shopping/items', { token: tGrocery, body: { items: [{ text: 'x' }] }, headers: { 'Idempotency-Key': 'run-1' } })));
  assert.equal(r.status, 422);
  assert.equal(r.body.error, 'idempotency-key-reused');
  r = await read(await shopPOST(req('POST', '/api/agent/shopping/items', { token: tGrocery, body })));
  assert.deepEqual(r.body.results.map((x) => x.status), ['unchanged', 'unchanged'], 'key + text replay -> unchanged');
  r = await read(await shopPOST(req('POST', '/api/agent/shopping/items', { token: tOther, body: { items: [{ text: 'milk 2%', qty: 4 }] } })));
  assert.deepEqual(r.body.results.map((x) => [x.id, x.status]), [[milkId, 'merged']]);
  // PATCH: other agent may complete but not edit
  r = await read(await itemPATCH(req('PATCH', `/api/agent/shopping/items/${milkId}`, { token: tOther, body: { qty: 9 } })));
  assert.equal(r.status, 403);
  r = await read(await itemPATCH(req('PATCH', `/api/agent/shopping/items/${milkId}`, { token: tGrocery, body: { qty: 6, note: 'organic' } })));
  assert.equal(r.status, 200);
  assert.equal(r.body.item.qty, 6);
  r = await read(await itemPATCH(req('PATCH', `/api/agent/shopping/items/${milkId}`, { token: tOther, body: { done: true } })));
  assert.equal(r.status, 200);
  assert.equal(r.body.item.done, true);
  r = await read(await itemPATCH(req('PATCH', '/api/agent/shopping/items/s_zzzzzzzz', { token: tGrocery, body: { done: true } })));
  assert.equal(r.status, 404);
  r = await read(await itemPATCH(req('PATCH', `/api/agent/shopping/items/${milkId}`, { token: tGrocery, body: { text: 'x' } })));
  assert.equal(r.status, 422);
  r = await read(await itemDELETE(req('DELETE', `/api/agent/shopping/items/${milkId}`, { token: tOther })));
  assert.equal(r.status, 403);
  r = await read(await itemDELETE(req('DELETE', `/api/agent/shopping/items/${milkId}`, { token: tGrocery })));
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'removed');
  r = await read(await itemDELETE(req('DELETE', `/api/agent/shopping/items/${milkId}`, { token: tGrocery })));
  assert.equal(r.status, 404);
});

await test('REST: chores + brief + If-Match + changes + views', async () => {
  let r = await read(await choresPUT(req('PUT', '/api/agent/chores', { token: tGrocery, body: { scope: { person: 'lilly', routine: 'morning' }, chores: [{ key: 'bed', person: 'lilly', routine: 'morning', title: 'Make bed', icon: '🛏️', stars: 1, recurrence: 'daily' }] } })));
  assert.equal(r.status, 200);
  assert.equal(r.body.results[0].status, 'created');
  r = await read(await briefPUT(req('PUT', `/api/agent/brief/${'2026-10-13'}`, { token: tGrocery, body: BRIEF() })));
  assert.equal(r.status, 422, 'week must be a Monday');
  const { mondayOf, todayIn } = ops;
  const week = mondayOf(todayIn());
  const brief = BRIEF();
  brief.days = []; brief.decisions[0].when.date = week; brief.decisions[1].when.date = week;
  r = await read(await briefPUT(req('PUT', `/api/agent/brief/${week}`, { token: tGrocery, body: brief })));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const rev = r.body.rev;
  assert.equal(r.headers.get('etag'), `"r${rev}"`);
  assert.equal(r.body.brief.todos.find((t) => t.key === undefined || t.text === 'Private item').text, 'Private item', 'no private:read -> redacted');
  // frame answers -> agent with stale If-Match gets 412
  const pickup = r.body.brief.decisions[0];
  const f = await boardPOST(req('POST', '/api/board', { body: { ops: [{ op: 'brief.assign', decision: pickup.id, slot: pickup.slots[0].id, who: { person: 'hayley' } }] }, headers: { origin: ORIGIN } }));
  assert.equal(f.status, 200);
  r = await read(await briefPUT(req('PUT', `/api/agent/brief/${week}`, { token: tGrocery, body: brief, headers: { 'If-Match': `"r${rev}"` } })));
  assert.equal(r.status, 412);
  r = await read(await briefPUT(req('PUT', `/api/agent/brief/${week}`, { token: tGrocery, body: brief, headers: { 'If-Match': 'nope' } })));
  assert.equal(r.status, 422);
  const ch = await read(await changesGET(req('GET', `/api/agent/changes?since=${rev}`, { token: tGrocery })));
  assert.equal(ch.status, 200);
  assert.ok(ch.body.events.some((e) => e.actor === 'frame' && e.section === 'brief' && e.op === 'assign' && /→ Hayley/.test(e.summary)), JSON.stringify(ch.body));
  assert.ok(ch.body.next > rev);
  r = await read(await briefPUT(req('PUT', `/api/agent/brief/${week}`, { token: tGrocery, body: brief, headers: { 'If-Match': `"r${ch.body.next}"` } })));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.brief.decisions[0].slots[0].who, { person: 'hayley' }, 'republish keeps frame who');
  const empty = await read(await changesGET(req('GET', `/api/agent/changes?since=${r.body.rev}`, { token: tGrocery })));
  assert.deepEqual(empty.body, { next: r.body.rev, events: [] });
  assert.equal((await changesGET(req('GET', '/api/agent/changes', { token: tGrocery }))).status, 422);
  // board views
  const plain = await read(await agentBoard(req('GET', '/api/agent/board', { token: tReader })));
  assert.equal(plain.status, 200);
  assert.ok(!JSON.stringify(plain.body).includes('4825'));
  assert.deepEqual(plain.body.people.map((p) => p.id), ['nate', 'hayley', 'lilly', 'daisy']);
  const priv = await read(await agentBoard(req('GET', '/api/agent/board', { token: tPrivate })));
  assert.ok(JSON.stringify(priv.body).includes('ending 4825'), 'private:read sees real text');
  assert.equal((await agentBoard(req('GET', '/api/agent/board', { token: tReader, headers: { 'If-None-Match': plain.headers.get('etag') } }))).status, 304);
  assert.equal((await agentBoard(req('GET', '/api/agent/board?week=2026-10-13', { token: tReader }))).status, 422);
});

await test('REST: review-mode token', async () => {
  let r = await read(await shopPOST(req('POST', '/api/agent/shopping/items', { token: tReview, body: { items: [{ key: 'flyer', text: 'Pumpkins', qty: 2 }] } })));
  assert.equal(r.status, 200);
  assert.equal(r.body.results[0].status, 'pending');
  r = await read(await choresPUT(req('PUT', '/api/agent/chores', { token: tReview, body: { chores: [{ person: 'daisy', routine: 'evening', title: 'Pajamas' }] } })));
  assert.equal(r.status, 202);
  assert.equal(r.body.status, 'pending');
  const fr = await read(await boardGET(req('GET', '/api/board')));
  assert.ok(fr.body.pending.some((p) => p.summary === 'Add Pumpkins ×2' && p.source.label === 'School email'));
  assert.ok(!fr.body.shopping.items.some((s) => s.text === 'Pumpkins'));
});

await test('REST: rate limit 429 after 10 writes/min', async () => {
  store.rateHit = realRateHit;
  const t = await mk('Chatty', 'shopping:write');
  for (let i = 0; i < 10; i++) {
    const r = await shopPOST(req('POST', '/api/agent/shopping/items', { token: t, body: { items: [{ text: `Thing ${i}` }] } }));
    assert.equal(r.status, 200, `write ${i}`);
  }
  const r = await read(await shopPOST(req('POST', '/api/agent/shopping/items', { token: t, body: { items: [{ text: 'One more' }] } })));
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get('retry-after')) >= 1);
  assert.equal((await agentBoard(req('GET', '/api/agent/board', { token: tReader }))).status, 200, 'reads are not limited');
  store.rateHit = async () => ({ minute: 1, hour: 1, resetMinute: 0, resetHour: 0 });
});

await test('REST: openapi is public and complete', async () => {
  for (const h of [openapiGET, openapiJsonGET]) {
    const r = await read(await h(req('GET', '/api/agent/openapi.json')));
    assert.equal(r.status, 200);
    assert.equal(r.body.openapi, '3.1.0');
    assert.equal(r.body.servers[0].url, `${ORIGIN}/api/agent`);
    assert.deepEqual(Object.keys(r.body.paths).sort(), ['/board', '/brief/{week}', '/changes', '/chores', '/shopping/items', '/shopping/items/{id}', '/shopping/updates']);
    const opIds = Object.values(r.body.paths).flatMap((p) => Object.values(p).filter((o) => o && o.operationId).map((o) => o.operationId));
    assert.deepEqual(opIds.sort(), ['addShoppingItems', 'getBoard', 'listChanges', 'publishWeeklyBrief', 'removeShoppingItem', 'setChores', 'shoppingUpdates', 'updateShoppingItem']);
    assert.equal(r.body.components.securitySchemes.bearerAuth.scheme, 'bearer');
  }
});

await test('dev token: memory store only, never on Vercel', async () => {
  process.env.BOARD_DEV_TOKEN = 'local-dev-token-123';
  const rec = await resolveToken(store, 'Bearer local-dev-token-123');
  assert.equal(rec.id, 'a_devtoken');
  assert.ok(rec.scopes.includes('private:read'));
  assert.equal(await resolveToken({ ...store, kind: 'redis' }, 'Bearer local-dev-token-123'), null);
  process.env.VERCEL = '1';
  assert.equal(await resolveToken(store, 'Bearer local-dev-token-123'), null);
  env();
});

await test('not configured on Vercel without Redis -> 503', async () => {
  setStore(null);
  env({ VERCEL: '1' });
  const r = await read(await agentBoard(req('GET', '/api/agent/board', { token: tGrocery })));
  assert.equal(r.status, 503);
  assert.equal(r.body.error, 'not-configured');
  const f = await boardGET(req('GET', '/api/board')); // no FRAME_KEY on Vercel -> locked first
  assert.equal(f.status, 401);
  env();
  setStore(store);
});

// ------------------------------------------------------------ frame endpoint
await test('frame GET: ETag, 304, day-aware, redacted', async () => {
  const r = await read(await boardGET(req('GET', '/api/board')));
  assert.equal(r.status, 200);
  const etag = r.headers.get('etag');
  assert.match(etag, /^"r\d+"$/);
  assert.equal(etag, `"r${r.body.rev}"`);
  assert.deepEqual(Object.keys(r.body).sort(), ['brief', 'chores', 'pending', 'people', 'rev', 'shopping']);
  assert.ok(r.body.brief, 'current week brief present');
  assert.ok(!JSON.stringify(r.body).includes('4825') && !JSON.stringify(r.body).includes('_set'));
  const nm = await boardGET(req('GET', '/api/board', { headers: { 'If-None-Match': etag } }));
  assert.equal(nm.status, 304);
  assert.equal(nm.headers.get('etag'), etag);
  await shopPOST(req('POST', '/api/agent/shopping/items', { token: tGrocery, body: { items: [{ text: 'Bread' }] } }));
  const changed = await boardGET(req('GET', '/api/board', { headers: { 'If-None-Match': etag } }));
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.get('etag'), etag);
});

await test('frame POST: origin, content-type, limits, ops, 409', async () => {
  const add = { ops: [{ op: 'shopping.add', text: 'Butter', qty: 2 }] };
  assert.equal((await boardPOST(req('POST', '/api/board', { body: add }))).status, 403, 'no Origin');
  assert.equal((await boardPOST(req('POST', '/api/board', { body: add, headers: { origin: 'https://evil.example' } }))).status, 403);
  assert.equal((await boardPOST(req('POST', '/api/board', { body: add, headers: { 'sec-fetch-site': 'same-origin' } }))).status, 200);
  assert.equal((await boardPOST(req('POST', '/api/board', { body: JSON.stringify(add), raw: true, headers: { origin: ORIGIN, 'content-type': 'text/plain' } }))).status, 415);
  assert.equal((await boardPOST(req('POST', '/api/board', { body: JSON.stringify({ ops: [], pad: 'x'.repeat(17000) }), raw: true, headers: { origin: ORIGIN } }))).status, 413);
  assert.equal((await boardPOST(req('POST', '/api/board', { body: { ops: Array.from({ length: 21 }, () => add.ops[0]) }, headers: { origin: ORIGIN } }))).status, 400);
  assert.equal((await boardPOST(req('POST', '/api/board', { body: { ops: [{ op: 'shopping.add', text: '' }] }, headers: { origin: ORIGIN } }))).status, 400);
  assert.equal((await boardPOST(req('POST', '/api/board', { body: '{x', raw: true, headers: { origin: ORIGIN } }))).status, 400);
  const r = await read(await boardPOST(req('POST', '/api/board', { body: add, headers: { origin: ORIGIN } })));
  assert.equal(r.status, 200);
  const butter = r.body.board.shopping.items.find((s) => s.text === 'Butter');
  assert.equal(butter.qty, 2, 'frame add merges (need at least)');
  assert.deepEqual(butter.addedBy, { agent: 'frame', label: 'Frame' });
  assert.equal(r.headers.get('etag'), `"r${r.body.board.rev}"`);
  const choreId = r.body.board.chores.items[0].id;
  const t = await read(await boardPOST(req('POST', '/api/board', { body: { ops: [{ op: 'shopping.toggle', id: butter.id, done: true }, { op: 'chore.done', id: choreId, by: { person: 'lilly' }, done: true }] }, headers: { origin: ORIGIN } })));
  assert.equal(t.status, 200);
  assert.equal(t.body.board.shopping.items.find((s) => s.id === butter.id).done, true);
  assert.deepEqual(t.body.board.chores.items.find((c) => c.id === choreId).doneToday.by, { person: 'lilly' });
  const before = (await store.read()).rev;
  const g = await read(await boardPOST(req('POST', '/api/board', { body: { ops: [{ op: 'shopping.remove', id: butter.id }, { op: 'shopping.toggle', id: 's_zzzzzzzz', done: true }] }, headers: { origin: ORIGIN } })));
  assert.equal(g.status, 409);
  assert.equal(g.body.error, 'gone');
  assert.equal((await store.read()).rev, before, 'batch is atomic');
  const ch = await read(await changesGET(req('GET', `/api/agent/changes?since=${before - 2}`, { token: tGrocery })));
  assert.ok(ch.body.events.some((e) => e.actor === 'frame' && e.op === 'done' && e.section === 'chores' && e.summary.includes('by Lilly')));
});

await test('frame key gate on /api/board', async () => {
  env({ FRAME_KEY: 'sekrit' });
  assert.equal((await boardGET(req('GET', '/api/board'))).status, 401);
  assert.equal((await boardGET(req('GET', '/api/board', { headers: { cookie: 'frame_key=sekrit' } }))).status, 200);
  assert.equal((await boardPOST(req('POST', '/api/board', { body: { ops: [] }, headers: { origin: ORIGIN } }))).status, 401);
  env();
});

// ------------------------------------------------------------ middleware
await test('middleware: agent API + MCP bypass the frame key, everything else gated', async () => {
  env({ FRAME_KEY: 'sekrit' });
  const mw = (path, headers = {}) => middleware(new Request('https://frame.example' + path, { headers }));
  for (const p of ['/api/agent/board', '/api/agent/openapi.json', '/api/agent/openapi', '/api/agent/shopping/items/s_abcdefgh', '/api/mcp']) {
    assert.equal(mw(p).headers.get('x-middleware-next'), '1', p);
  }
  for (const p of ['/', '/api/board', '/api/schedule', '/api/agent', '/api/agent/../board', '/api/agent/%2e%2e/board', '/api/mcpx', '/index.html']) {
    assert.equal(mw(p).status, 401, p);
  }
  assert.equal(mw('/api/board', { cookie: 'frame_key=sekrit' }).headers.get('x-middleware-next'), '1');
  assert.ok(bypassesFrameKey('/api/agent/changes') && !bypassesFrameKey('/api/agents'));
  env();
});

// ------------------------------------------------------------ review regressions
await test('regression 1: private text never leaks through keys (auto or agent keys)', () => {
  const doc = ops.emptyDoc();
  const draft = validateBriefPut(WEEK, { todos: [{ text: 'Zelle Kristin $150' }, { key: 'zelle-kristin-150', text: 'Pay Kristin via Zelle $150' }], decisions: [{ key: 'bay-psych-ride', title: 'Ride to Bay Psych', when: { date: '2026-10-14' } }] });
  for (const t of draft.todos) assert.ok(!/zelle|kristin|150/i.test(t.key.replace('zelle-kristin-150', '')), t.key);
  assert.match(draft.todos[0].key, /^auto:[0-9a-f]{16}$/);
  ops.publishBrief(doc, draft, ctxFor(agentA));
  const b = doc.briefs[WEEK];
  const f = ctxFor(ops.FRAME_ACTOR);
  const d = b.decisions[0];
  assert.equal(d.private, true);
  ops.applyFrameOps(doc, [
    { op: 'brief.todo', id: b.todos[0].id, done: true },
    { op: 'brief.owner', id: b.todos[1].id, owner: { person: 'hayley' } },
    { op: 'brief.dismiss', kind: 'todo', id: b.todos[1].id, reason: '' },
    { op: 'brief.assign', decision: d.id, slot: d.slots[0].id, who: { person: 'nate' } },
  ], f);
  for (const e of f.events) assert.equal(e.key, null, `${e.op} key`);
  const evs = JSON.stringify(f.events);
  assert.ok(!/zelle|kristin|150|psych/i.test(evs), evs);
  const view = JSON.stringify(briefView(doc.briefs[WEEK], { audience: 'agent' }));
  assert.ok(!/zelle|psych/i.test(view), 'no key/text in a non-private:read view');
  assert.ok(/zelle-kristin-150/.test(JSON.stringify(briefView(doc.briefs[WEEK], { audience: 'agent', reveal: true }))), 'private:read still sees its keys');
});

await test('regression 2: lastUsedAt touch can never undo a concurrent revoke', async () => {
  const t = await mk('Racer', 'board:read');
  const id = (await store.tokenGet(hashToken(t))).id;
  const origTouch = store.tokenTouch;
  const origUpdate = store.tokenUpdate;
  let updates = 0;
  store.tokenUpdate = async (...a) => { updates++; return origUpdate(...a); };
  // The revoke lands while the touch is in flight.
  store.tokenTouch = async (tid, at) => { await revokeToken(store, tid); return origTouch(tid, at); };
  assert.ok(await resolveToken(store, `Bearer ${t}`), 'request already past the check');
  store.tokenTouch = origTouch;
  assert.equal(updates, 1, 'only the revoke rewrote the record');
  store.tokenUpdate = origUpdate;
  assert.equal(await resolveToken(store, `Bearer ${t}`), null, 'still revoked');
  const rec = (await store.tokenList()).find((r) => r.id === id);
  assert.ok(rec.revokedAt && rec.lastUsedAt);
});

await test('regression 3: review-mode patches merge instead of dropping earlier ones', () => {
  const doc = ops.emptyDoc();
  const a = ctxFor(agentA);
  const { id } = ops.addShoppingItem(doc, { text: 'Milk', qty: 1 }, a);
  const r = ctxFor(agentA, { mode: 'review' });
  const p1 = ops.agentUpdateShopping(doc, id, { qty: 3 }, r);
  const p2 = ops.agentUpdateShopping(doc, id, { done: true }, r);
  assert.equal(p1.pending, p2.pending);
  assert.equal(doc.pending.length, 1);
  assert.deepEqual(doc.pending[0].payload.patch, { qty: 3, done: true });
  assert.equal(doc.pending[0].summary, 'Milk: check off, qty 3');
  ops.approvePending(doc, p1.pending, ctxFor(ops.FRAME_ACTOR));
  const item = doc.shopping.items.find((x) => x.id === id);
  assert.equal(item.qty, 3);
  assert.equal(item.done, true);
});

await test('regression 4: agent board ETag covers ?week= and private:read', async () => {
  const cur = await read(await agentBoard(req('GET', '/api/agent/board', { token: tReader })));
  const etag = cur.headers.get('etag');
  const nextWeek = (await import('../lib/board/schema.js')).addDays(ops.mondayOf(ops.todayIn()), 7);
  const wk = await agentBoard(req('GET', `/api/agent/board?week=${nextWeek}`, { token: tReader, headers: { 'If-None-Match': etag } }));
  assert.equal(wk.status, 200, 'other week is a different representation');
  assert.notEqual(wk.headers.get('etag'), etag);
  assert.equal((await agentBoard(req('GET', `/api/agent/board?week=${nextWeek}`, { token: tReader, headers: { 'If-None-Match': wk.headers.get('etag') } }))).status, 304);
  const priv = await agentBoard(req('GET', '/api/agent/board', { token: tPrivate, headers: { 'If-None-Match': etag } }));
  assert.equal(priv.status, 200, 'private:read view is a different representation');
  assert.match(priv.headers.get('etag'), /^"r\d+-p"$/);
});

await test('regression 5: malformed percent-encoding in a path param -> 404', async () => {
  let r = await read(await itemPATCH(req('PATCH', '/api/agent/shopping/items/%E0%A4%A', { token: tGrocery, body: { done: true } })));
  assert.equal(r.status, 404);
  r = await read(await itemDELETE(req('DELETE', '/api/agent/shopping/items/%ZZ', { token: tGrocery })));
  assert.equal(r.status, 404);
  r = await read(await briefPUT(req('PUT', '/api/agent/brief/%E0%A4%A', { token: tGrocery, body: {} })));
  assert.equal(r.status, 404);
});

await test('regression 6: idempotency key is reserved atomically', async () => {
  const body = { items: [{ text: 'Concurrent cheese' }] };
  const send = (b = body) => shopPOST(req('POST', '/api/agent/shopping/items', { token: tGrocery, body: b, headers: { 'Idempotency-Key': 'race-1' } }));
  const [x, y] = await Promise.all([send(), send()]);
  const statuses = [x.status, y.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  const loser = await read(x.status === 409 ? x : y);
  assert.equal(loser.body.error, 'in-progress');
  const doc = (await store.read()).doc;
  assert.equal(doc.shopping.items.filter((i) => i.text === 'Concurrent cheese').length, 1);
  const replay = await send();
  assert.equal(replay.headers.get('idempotent-replayed'), 'true');
  // a failed request releases its reservation
  const k2 = (b) => shopPOST(req('POST', '/api/agent/shopping/items', { token: tGrocery, body: b, headers: { 'Idempotency-Key': 'race-2' } }));
  assert.equal((await k2({ items: [{ text: '' }] })).status, 422);
  assert.equal((await k2({ items: [{ text: 'Crackers' }] })).status, 200, 'key reusable after a failed attempt');
});

// ------------------------------------------------------------ change cursors + shopping digest
await test('collapse: done/undone flips within 60 s collapse to the final state; add/remove kept', () => {
  const at = (s) => new Date(Date.UTC(2026, 9, 13, 14, 0, s)).toISOString();
  const ev = (rev, op, s, id = 's_aaaaaaaa') => ({ rev, section: 'shopping', op, id, at: at(s) });
  const out = collapseEvents([ev(1, 'add', 0), ev(2, 'done', 10), ev(3, 'undone', 20), ev(4, 'done', 30), ev(5, 'remove', 40)]);
  assert.deepEqual(out.map((e) => `${e.rev}:${e.op}`), ['1:add', '4:done', '5:remove']);
  assert.deepEqual(collapseEvents([ev(1, 'done', 0), ev(2, 'undone', 5)]), [], 'done→undone nets to nothing');
  const slow = collapseEvents([ev(1, 'done', 0), { ...ev(2, 'undone', 0), at: new Date(Date.UTC(2026, 9, 13, 14, 2)).toISOString() }]);
  assert.equal(slow.length, 2, 'outside 60 s both stay');
  const other = collapseEvents([ev(1, 'done', 0), ev(2, 'undone', 5, 's_bbbbbbbb')]);
  assert.equal(other.length, 2, 'different items never collapse');
});

await test('cursor: since=last advances, peek does not, first call = last 7 days, sections, numeric unchanged', async () => {
  const s2 = createMemoryStore();
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const push = (at, section, op, extra = {}) => s2.apply((doc, events) => { doc.day = iso(at); events.push({ section, op, id: null, key: null, actor: 'frame', actorLabel: 'Frame', at: iso(at), summary: op, ...extra }); });
  await push(now - 10 * 86400000, 'shopping', 'old'); // rev 1 (older than 7 days)
  await push(now - 2 * 86400000, 'shopping', 'add', { text: 'Milk', qty: 1 }); // rev 2
  await push(now - 86400000, 'brief', 'assign'); // rev 3
  const first = await listChanges(s2, { since: 'last', tokenId: 'a_t1' });
  assert.deepEqual(first.events.map((e) => e.rev), [2, 3], 'first call: last 7 days');
  assert.equal(first.cursor.first, true);
  assert.equal(await s2.cursorGet('a_t1', ''), 3);
  assert.equal((await listChanges(s2, { since: 'last', tokenId: 'a_t1' })).events.length, 0);
  await push(now, 'chores', 'done'); // rev 4
  await push(now, 'shopping', 'add', { text: 'Eggs', qty: 1 }); // rev 5
  const peek = await listChanges(s2, { since: 'last', tokenId: 'a_t1', peek: true });
  assert.deepEqual(peek.events.map((e) => e.rev), [4, 5]);
  assert.equal(await s2.cursorGet('a_t1', ''), 3, 'peek leaves the cursor');
  const shopOnly = await listChanges(s2, { since: 'last', tokenId: 'a_t1', sections: ['shopping'] });
  assert.deepEqual(shopOnly.events.map((e) => e.rev), [5]);
  assert.equal(shopOnly.next, 5);
  assert.equal(await s2.cursorGet('a_t1', ''), 5, 'filtered read still advances past other sections');
  assert.equal((await listChanges(s2, { since: 'last', tokenId: 'a_t1' })).events.length, 0, 'no replay of the chores event');
  const numeric = await listChanges(s2, { since: 1, sections: ['brief', 'chores'], tokenId: 'a_t1' });
  assert.deepEqual(numeric.events.map((e) => e.rev), [3, 4]);
  assert.equal(numeric.since, undefined, 'numeric mode shape unchanged');
  assert.equal(await s2.cursorGet('a_t1', ''), 5, 'numeric mode never touches the cursor');
  assert.equal(await s2.cursorGet('a_t2', ''), null, 'cursors are per token');
});

await test('cursor: Redis key naming', async () => {
  assert.equal(cursorKey('a_abc12345'), 'fb:cursor:a_abc12345');
  assert.equal(cursorKey('a_abc12345', 'shopping'), 'fb:cursor:a_abc12345:shopping');
  const calls = [];
  const fake = { get: async (k) => { calls.push(['get', k]); return '7'; }, set: async (k, v, o) => { calls.push(['set', k, v, o]); return 'OK'; } };
  const rs = await createRedisStore({ client: fake });
  assert.equal(await rs.cursorGet('a_abc12345', 'shopping'), 7);
  await rs.cursorSet('a_abc12345', '', 9);
  assert.deepEqual(calls[0], ['get', 'fb:cursor:a_abc12345:shopping']);
  assert.equal(calls[1][1], 'fb:cursor:a_abc12345');
  assert.equal(calls[1][2], '9');
});

await test('REST changes: since=last, section, peek, validation; frame shopping events carry item fields', async () => {
  const bot = await mk('Grok bot', 'board:read,changes:read');
  await read(await changesGET(req('GET', '/api/agent/changes?since=last', { token: bot })));
  const r0 = await read(await boardPOST(req('POST', '/api/board', { body: { ops: [{ op: 'shopping.add', text: 'Lemons', qty: 3, store: 'Costco' }] }, headers: { origin: ORIGIN } })));
  const lemons = r0.body.board.shopping.items.find((s) => s.text === 'Lemons');
  await boardPOST(req('POST', '/api/board', { body: { ops: [{ op: 'shopping.toggle', id: lemons.id, done: true, by: { person: 'daisy' } }] }, headers: { origin: ORIGIN } }));
  const pk = await read(await changesGET(req('GET', '/api/agent/changes?since=last&section=shopping&peek=1', { token: bot })));
  assert.equal(pk.status, 200);
  const done = pk.body.events.find((e) => e.op === 'done' && e.id === lemons.id);
  assert.deepEqual({ actor: done.actor, actorLabel: done.actorLabel, text: done.text, qty: done.qty, store: done.store, doneBy: done.doneBy }, { actor: 'frame', actorLabel: 'Frame', text: 'Lemons', qty: 3, store: 'Costco', doneBy: 'Daisy' });
  assert.equal(shoppingSentence(done), 'Lemons (3) was checked off on the frame by Daisy');
  const got = await read(await changesGET(req('GET', '/api/agent/changes?since=last&section=shopping', { token: bot })));
  assert.deepEqual(got.body.events.map((e) => e.rev), pk.body.events.map((e) => e.rev), 'peek then read returns the same events');
  assert.equal((await read(await changesGET(req('GET', '/api/agent/changes?since=last', { token: bot })))).body.events.length, 0);
  assert.equal((await changesGET(req('GET', '/api/agent/changes?since=last&section=bogus', { token: bot }))).status, 422);
  assert.equal((await changesGET(req('GET', '/api/agent/changes?since=yesterday', { token: bot }))).status, 422);
});

await test('REST shopping/updates: digest, own cursor independent of /changes, scopes', async () => {
  const bot = await mk('Grok digest', 'board:read,changes:read');
  assert.equal((await shopUpdatesGET(req('GET', '/api/agent/shopping/updates', { token: tReader }))).status, 403, 'needs changes:read too');
  await shopUpdatesGET(req('GET', '/api/agent/shopping/updates', { token: bot })); // prime
  await read(await changesGET(req('GET', '/api/agent/changes?since=last', { token: bot }))); // prime list cursor
  const r0 = await read(await boardPOST(req('POST', '/api/board', { body: { ops: [{ op: 'shopping.add', text: 'Limes', qty: 2 }, { op: 'shopping.add', text: 'Rice' }] }, headers: { origin: ORIGIN } })));
  const limes = r0.body.board.shopping.items.find((s) => s.text === 'Limes');
  await boardPOST(req('POST', '/api/board', { body: { ops: [{ op: 'shopping.toggle', id: limes.id, done: true }] }, headers: { origin: ORIGIN } }));
  const peek = await read(await shopUpdatesGET(req('GET', '/api/agent/shopping/updates?peek=1', { token: bot })));
  const d = await read(await shopUpdatesGET(req('GET', '/api/agent/shopping/updates', { token: bot })));
  assert.deepEqual(peek.body.since_last_check, d.body.since_last_check, 'peek does not advance');
  assert.deepEqual(d.body.since_last_check, ['Limes (2) was added on the frame', 'Rice was added on the frame', 'Limes (2) was checked off on the frame']);
  assert.ok(d.body.still_needed.some((s) => s.text === 'Rice') && !d.body.still_needed.some((s) => s.text === 'Limes'));
  assert.ok(d.body.still_needed.every((s) => Object.keys(s).sort().join() === 'qty,store,text'));
  assert.equal(d.body.counts.changes, 3);
  const lines = d.body.summary.split('\n');
  assert.ok(lines.length >= 2 && lines.length <= 4);
  assert.match(lines[0], /^Since your last check: Limes \(2\) was added on the frame;/);
  assert.match(lines[1], /^Still needed \(\d+\): /);
  assert.equal((await read(await shopUpdatesGET(req('GET', '/api/agent/shopping/updates', { token: bot })))).body.counts.changes, 0);
  const lc = await read(await changesGET(req('GET', '/api/agent/changes?since=last&section=shopping', { token: bot })));
  assert.equal(lc.body.events.length, 3, 'the digest did not consume /changes events');
  // own writes are not echoed back
  const writer = await mk('Grocery writer', 'board:read,changes:read,shopping:write');
  await shopUpdatesGET(req('GET', '/api/agent/shopping/updates', { token: writer }));
  await shopPOST(req('POST', '/api/agent/shopping/items', { token: writer, body: { items: [{ text: 'Tortillas' }] } }));
  assert.equal((await read(await shopUpdatesGET(req('GET', '/api/agent/shopping/updates', { token: writer })))).body.counts.changes, 0);
});

await test('getStore picks memory outside Vercel', async () => {
  setStore(null);
  const s = await getStore();
  assert.equal(s.kind, 'memory');
  setStore(store);
});

console.log(`${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
