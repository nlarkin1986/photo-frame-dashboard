# Board contract (canonical — all build agents code against this)

Context: `docs/plans/agent-publishing.md`. Research detail (non-canonical where it differs):
`/private/tmp/claude-501/-Users-natelarkin-Frame/239c54e5-c3c2-4e6e-b264-478dd7a2c67e/scratchpad/research-publish-api.md`.
View mockup: `.../scratchpad/week-view/week.html`, `week.css`, `home.html`, `week.png`, `home-week-tile.png`.

## Household
`people`: `nate` (Nate, grown-up), `hayley` (Hayley, grown-up), `lilly` (Lilly, kid), `daisy` (Daisy, kid).
Fixed in `lib/board/people.js` (id, name, role `adult|kid`, color). Helpers (e.g. a nanny) are NOT people:
agents may name them as plain text (`{ "name": "Kristin" }`) in assignable fields.
A "who" value is `{ "person": "<id>" }` or `{ "name": "<text ≤24>" }` or `null`.

## Board document (what the frame receives from `GET /api/board`)
```jsonc
{
  "rev": 42,                                   // global revision; ETag is "r42"
  "people": [{ "id":"nate","name":"Nate","role":"adult","color":"#…" }, …],
  "shopping": { "items": [ShoppingItem…] },
  "chores":   { "items": [Chore…] },           // includes today's done state
  "brief":    Brief | null,                    // current week's brief (Monday of the frame's week)
  "pending":  [PendingSuggestion…]             // review-mode agent writes awaiting approval
}
```
`addedBy` / `source` on every item: `{ "agent": "<token id>", "label": "Grocery agent" }` or `{ "agent": "frame", "label": "Frame" }`.

**ShoppingItem**: `{ id, key?, text(≤60), qty(1–99), store(≤24|null), category(≤24|null), note(≤80), suggested(bool), done, doneBy(who|null), doneAt, addedBy, addedAt, updatedAt }`
**Chore**: `{ id, key?, person(id|"any"), routine("morning"|"after"|"evening"), title(≤40), icon(single emoji or allow-listed name), stars(0–3), due(ISO date|null), recurrence("daily"|"weekdays"|null), doneToday({ by: who, at }|null), addedBy }`
**Brief**:
```jsonc
{ "week":"2026-10-12", "title":"October 12–18", "publishedAt":"…", "source":{ "agent","label" },
  "headline":[{ "id","person":id|null,"text"(≤80) }],                       // ≤4
  "days":[{ "date","care":{ "who":who,"needed":bool,"label"(≤40)? },
            "specials":[{ "person":id,"text"(≤60) }],
            "items":[{ "id","kind":"timed"|"allDay"|"deadline"|"note","time"(≤16)?,"text"(≤100),
                       "people":[id],"place"(≤60)?,"decision":<decision id>?,"private":bool }] }],   // 7 days Mon..Sun
  "decisions":[{ "id","title"(≤80),"context"(≤120)?,"when":{ "date","time"? },"kind":"care"|"ride"|"other",
                 "slots":[{ "id","label"(≤24),"date"? ,"who":who }],"candidates":[who],"done":bool,"private":bool }],
  "todos":[{ "id","text"(≤120),"owner":who,"due"?,"link":{ "host","label" }?,"done":bool,"private":bool }],
  "stillOpen":[{ "id","text"(≤60) }],
  "comingUp":[{ "id","date","time"?,"text"(≤100),"place"? }],
  "notes":[{ "id","text"(≤140) }] }
```
**Private items** (`private:true`) reach the frame with their text REPLACED server-side by a generic label
("Private item", "Private appointment") and `owner`/`time` kept. The real text never leaves the server.
Ids are server-generated (`^[a-z]_[a-z0-9]{8}$`); agents correlate via their own `key`.

## Frame write-back: `POST /api/board` (FRAME_KEY cookie, same-origin, JSON ≤16 KB, ≤20 ops)
Ops: `shopping.add {text, qty?, store?}` · `shopping.toggle {id, done}` · `shopping.remove {id}` ·
`chore.done {id, by: who|null, done: bool}` · `brief.assign {decision, slot, who}` · `brief.todo {id, done}` ·
`brief.owner {id, owner: who}` · `brief.dismiss {kind:"decision"|"todo", id, reason}` ·
`pending.approve {id}` · `pending.dismiss {id}`.
Response `200 { board }` (full document) | `409 { error }` | `400/403/413/415`.

## Agent API (outside agents — any language): base `/api/agent`, `Authorization: Bearer fb_…`
- `GET /api/agent/board` → board document, but private items include their real text only for tokens with scope `private:read` (default no).
- `POST /api/agent/shopping/items {items:[{key?,text,qty?,store?,category?,note?,confidence?:"sure"|"suggest"}]}` → `{rev, results:[{key,id,status:"created"|"merged"|"unchanged"|"pending"}]}`
- `PATCH /api/agent/shopping/items/{id} {done?, qty?, note?}` · `DELETE /api/agent/shopping/items/{id}`
- `PUT /api/agent/chores {scope:{person?,routine?}, chores:[…]}` (replaces only this agent's chores in scope)
- `PUT /api/agent/brief/{week} {…Brief fields with agent keys instead of ids…}` optional `If-Match: "r<rev>"` → 412 if stale.
  Republish keeps frame-owned state (who, done, owner, dismissed) matched by key.
- `GET /api/agent/changes?since=<rev>` → `{next, events:[{rev, section, op, id, key, actor, at, summary}]}`
- `GET /api/agent/openapi.json` (no auth) — OpenAPI 3.1 for all of the above (for GPT Actions, n8n, etc.).
Scopes per token: `board:read`, `shopping:write`, `chores:write`, `brief:write`, `changes:read`, `private:read`.
Mode per token: `direct` | `review` (writes become `pending` until approved on the frame).
Errors: `401` bad/revoked token, `403` scope, `409` conflict, `412` If-Match, `413`, `415`, `422 {error, details}`, `429` rate limit.

## MCP: `/api/mcp` (Streamable HTTP, same bearer tokens) — tools wrap the agent API 1:1:
`get_board`, `add_shopping_items`, `update_shopping_item`, `remove_shopping_item`, `set_chores`,
`publish_weekly_brief`, `list_changes`.

## Storage
Upstash Redis (`@upstash/redis`, env `KV_REST_API_URL`/`KV_REST_API_TOKEN` or `UPSTASH_REDIS_REST_URL`/`_TOKEN`),
with an in-memory implementation used when neither is set and not on Vercel (dev + tests).
