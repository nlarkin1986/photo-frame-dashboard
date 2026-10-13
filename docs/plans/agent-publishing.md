# Agents publishing to the board — Shopping, Chores, "What to know this week"

Research by three agents (publishing API, view design, owner's agents/sources), combined here.
Mockups: `week.png` (the new view with the Oct 12 brief) and `home-week-tile.png`.

## Recommendation

One board core (`lib/board/*`) with two front doors:
- **REST** `/api/agent/*` — bearer tokens per agent. Works today from Claude Code, Agent SDK scripts,
  cloud routines (curl, token as a network secret, host allow-listed), iOS Shortcuts, n8n/Zapier.
- **MCP** `/api/mcp` (`mcp-handler` v2, stateless, pinned) — tools `get_board`, `add_shopping_items`,
  `complete_shopping_item`, `remove_shopping_item`, `set_chores`, `publish_weekly_brief`, `list_changes`.
  Works with Claude Code (`claude mcp add --transport http … --header`) and the Agent SDK.
- **OAuth (later phase)** so the board can be a claude.ai custom connector (web, Claude mobile, routines).

**Storage: Upstash Redis (Vercel Marketplace, free tier).** Not Blob: the frame's 30–60 s polling
(~86k reads/month) is ~8× the Hobby Blob quota, and exceeding it locks Blob for 30 days — photos included.
Layout `fb:*`: one JSON doc per section, global `rev` → ETag, a changes stream, idempotency keys,
hashed tokens, a review queue. Writes are compare-and-set (Lua), retried on a lost race.

**Frame:** `GET /api/board` polled with ETag (same pattern as the schedule); taps go to `POST /api/board`
(FRAME_KEY cookie + Origin check). Taps land in the changes stream; agents read `list_changes(since)`.

`middleware.js` must let `/api/agent/*`, `/api/mcp`, `/.well-known/oauth-*`, `/oauth/*` through without
FRAME_KEY — those authenticate themselves.

## Data (agents send plain text only; server sets ids, provenance, timestamps)

- **Shopping item**: `key` (idempotency), `text`≤60, `qty`, `store`, `category`, `note`; open items merge by
  normalised text; "need at least N" so republishing never doubles; low-confidence items → "Suggested".
- **Chore**: `key`, `person|any`, `routine` (morning/after/evening), `title`≤40, `icon` (emoji/allow-list),
  `stars` (default 0), `due`, `recurrence`; agents may remove only undone chores they created.
- **Weekly brief** (`week` = Monday): `headline[]`, `days[]` (care/coverage, school specials, timed items,
  deadlines, notes), `decisions[]` (slots with assignable `who`), `todos[]` (owner, due, link, optional
  agent action), `stillOpen[]`, `comingUp[]`, `source`. Stable `key`s so a republish keeps what the family
  did on the frame (who/done); family changes win unless the agent explicitly supersedes.
- People referenced by id: household + `helpers` (e.g. a nanny). Unknown id → 422 listing valid ids.

## Safety
- Text only, length limits, control/bidi/zero-width stripped; ids server-generated (also closes an existing
  escaping gap in `tasks.js` emoji/ids).
- **Sensitive content fails closed**: card/account numbers rejected; amounts, Zelle/Venmo/bank/fraud, PINs/codes,
  medical/therapy, legal → `private` (frame receives only id/owner/time: "2 private items · see your phone",
  "Private appointment 12:30"); phone numbers masked; no email addresses.
- Links shown as hostname text, never tappable (kiosk never navigates).
- Per-agent scopes, revocable; rate limits (10 writes/min, 120/h); **review mode** for email-reading agents
  (suggestions wait for Approve/Dismiss on the frame); "remove everything from this agent".

## "What to know this week" view (see mockup)
Header (week, headline chips per person, "Updated Sun 9:06 AM · School-email agent" with staleness colour) and
three columns: **the week** (day rows, care chips, red "No care yet", open questions highlighted, today ringed),
**Decide** (cards with Nate/Hayley/Kristin chips, multi-day care slots, countdown when due soon),
**To-dos / Still open / Coming up** (checkboxes, owner avatars, "N private items · see your phone").
Taps = assign/check (undo toast); holds = dismiss, "not needed", agent actions. Rail item "Week" with a badge;
Home "This week" tile (next decision, care gaps, open to-dos) replacing the lights/locks tile; ambient line.
Shopping/Chores gain "✦ agent" provenance chips and a "Suggested" group.

## Owner's agents (findings)
- Nothing on this Mac generated the Oct 12 briefs — likely a claude.ai chat on the personal account.
- No family automations exist yet; this workspace's Gmail/Calendar connectors are the Gladly work account.
  Family agents should run on the **personal** account and never touch work connectors.
- Telegram plugin is installed and paired — natural "text the board" path.
- Proposed agents: Sunday **Week-ahead** routine (publishes the brief; review for the first month),
  **Grocery** (Telegram / iOS Shortcut / recipe links; review for email-derived items), **Chores**
  (weekly plan + daily reset), **School-email watcher** (always review), optional claude.ai connector.

## Phases
- **P0 (owner):** add Upstash Redis to `photo-frame-dashboard` from the Vercel Marketplace; confirm household
  roster (people + helpers + stores).
- **P1 core:** `lib/board/store.js` (CAS, changes, idempotency, fake for tests), `schema.js` (validation,
  sanitising, privacy rules), `tokens.js` + `scripts/agent-token.mjs`, middleware bypass, `api/agent/*`, dev routes.
- **P2 frame:** `api/board.js` + `js/board-data.js`; Shopping, Chores, Home off mock data; new `js/views/week.js`
  + CSS; Home tile, rail badge, ambient line; frame write-back.
- **P3 MCP:** `api/mcp.js`; verify with MCP Inspector, `claude mcp add`, Agent SDK.
- **P4 OAuth:** minimal OAuth server for claude.ai connectors (web + mobile + routines).
- **P5:** review-queue UI, remove-by-agent, webhooks, first real agents (Week-ahead routine, Telegram grocery).

## Risks
mcp-handler v2 and connector header-auth are new/beta (pin, verify); Upstash free tier headroom ~5×;
a republished brief could drop items the family answered — keep them marked stale.
