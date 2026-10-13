# Schedule v2 on the frame — architecture and build plan

Two repos:
- **System A** — `/Users/natelarkin/dhc tools` (Next 16, Supabase; Vercel project `dhc-feelings-tools`, https://dhc-feelings-tools.vercel.app). Owns Schedule v2. Read its `AGENTS.md`/`CLAUDE.md` and `node_modules/next/dist/docs` for route handlers before writing Next code.
- **System B** — `/Users/natelarkin/Frame/photo-frame-dashboard/dashboard` (vanilla-JS Vite dashboard on Vercel, https://photo-frame-dashboard-three.vercel.app, shown in an Android 6 WebView 106 kiosk at 1280×800).

## Architecture

The Supabase `documents` row (`tool='schedule-v2'`) stays the single source of truth. System A gains a token-authenticated display API (`/api/display/*`): the token is revocable and only its SHA-256 is stored in a new `display_links` table. The API reads the latest planner with the service-role client, trims it to one week, and returns a compact display payload with inline SVG markup for the icons used and photo references by id/version. Frame writes are narrow ops applied server-side to the raw latest JSON and saved with compare-and-set; the phone's existing sync pulls them like any other device's edit.

On the frame, a thin `api/schedule.js` holds the System A token in an env var, enforces FRAME_KEY + Origin, proxies GET (ETag passthrough) and POST, and rewrites photo refs to `api/schedule-photo.js`, so the WebView only ever talks to its own origin. The browser polls every 30–60 s with `If-None-Match`; a phone edit appears within a minute.

```
Phone (System A editor)
  localStorage/IndexedDB --useDocSync (push 1.5s after edit)--> Supabase documents[schedule-v2] + Storage photos/{uid}/schedule-v2/{id}
                                                                   ^ service role (server only)
System A  /api/display/schedule  GET ?week=  (Bearer token -> display_links -> user_id) -> trimmed display JSON, ETag
          /api/display/schedule  POST {week, ops} -> applyOps(raw) -> display_push_document (CAS) -> fresh display
          /api/display/photo     GET ?id=&w=  -> Storage download -> resized JPEG
          /api/display/pictures  GET  -> icon catalogue (Phase 3)
             ^ server-to-server, Authorization: Bearer DHC_DISPLAY_TOKEN
Frame fn  api/schedule.js (GET/POST, FRAME_KEY + Origin checks, photo ref rewrite)
          api/schedule-photo.js (GET ?id&v | ?feeling=x, private immutable cache)
             ^ same origin, frame_key cookie
WebView   js/schedule-data.js (poll on 'minute', optimistic ticks) -> js/views/schedule.js, home tile
```

## Decisions

1. **Source of truth:** Supabase `documents` only; the frame is a client. (Rejected: copying into frame Blob — two-way sync, two conflict models.)
2. **Frame reads:** token-scoped System A endpoint called server-to-server by the frame function; System A trims (it owns the zod schemas, `shownSections`, `sectionLabel`, `shelfPhotos`). Poll 30 s while Schedule/Home is visible, else 60 s. ETag `"{updated_at}|{week}|{link.settings_rev}"`, 304 → no rebuild. Client computes `week` (Monday ISO) from its local clock. (Rejected: direct Supabase from WebView; Realtime websockets.)
3. **Phone push + linking:** existing auto-sync already pushes ~1.5 s after an edit. Add an "On the frame" panel in System A: create link (token shown once + Copy), choose kids (`settings.kids`), toggles for ticking/editing, revoke, and "Frame up to date" from `display_links.last_seen_version` vs doc `updated_at`. Token goes into the frame's Vercel env `DHC_DISPLAY_TOKEN`. (Rejected for now: QR pairing.)
4. **Editing on the frame:** (a) ticks — anyone (Phase 2). (b) add/remove/reorder/move cards, change time/label/length/travel, using icons + library photos — behind a press-and-hold Edit unlock (Phase 3). (c) not on frame: photo upload, kids, section names/hiding, PDF, copy days/weeks.
   Write path: frame `fetch POST /api/schedule` (same-origin JSON) → frame fn checks FRAME_KEY, `Origin` = own host or `Sec-Fetch-Site: same-origin`, `Content-Type: application/json`, body ≤16 KB, ≤20 ops → System A checks token + scope, loads row, `applyOps` on a `structuredClone` of raw `data` (not zod-parsed output, which strips unknown keys), validates with `PlannerSchema.safeParse`, saves via `display_push_document(uid, data, expected)` CAS, retry ≤3 on lost race.
   Conflicts: phone with no unsaved edits silently pulls on focus/online/mount. Phone with unsaved edits or in kid mode → conflict dialog. Phase 2 adds an optional `merge(local, remote)` hook to `useDocSync`; Schedule v2 supplies `mergeTicks` (if planners are equal ignoring `checked`, take remote structure, union `checked` per week, push). Structural edits on both sides still show the dialog.
5. **Icons:** System A's `lib/week-icon-nodes.ts` (generated from lucide-react by `scripts/gen-week-icons.mjs`) is the source. Display payload carries `icons: {name: "<path …/>…"}` for icons used that week. Phase 3 adds `/api/display/pictures` for the full picker. Frame falls back to `star`.
6. **Frame UI:** rail item "Schedule" after "Today" (8 items fit; keyboard shortcuts 1–8 in `system.js`). Kid tabs (avatars) top, Mon–Sun day strip (today highlighted), five section columns in `SECTION_INFO` tints (hidden/off sections dropped, remaining columns widen). Card: 72 px picture, label, time/length chips, travel icon. Current section by fixed hours (morning <11:00, midday 11–13, afternoon 13–17, evening 17–19:30, bedtime after) gets a bold border; first unticked card in it marked "Now". Rebuild only when payload changes — add `App.markDirty(name)` and a `'schedule'` event (don't use `App.emit('data')`, it marks every view stale); ticks toggle one element's class. Home: per-kid tile (avatar, "Now: …", done/total today) → `#schedule`. Ambient: one line "Lilly · next: Bath time". Unplanned week: "This week isn't planned yet — open the schedule on your phone." Remove `App.setTime(15, 18)` from `App.start`; keep demo-drawer time buttons; drop/reword the startup demo tip.
7. **Security/privacy:** token = 32 random bytes base64url prefixed `dhcf_`; store SHA-256 only; revoke via `revoked_at` (frame shows "Unlinked"); per-link scopes `can_tick`, `can_edit`. Service-role key never leaves System A; the System A token never reaches the WebView. FRAME_KEY and DHC_DISPLAY_TOKEN stay separate. JSON `no-store`; photos `private, max-age=31536000, immutable` keyed by `v`. Never log payloads. `last_used_at` written at most once a minute. Optional Vercel Firewall rate limit on `/api/display/*`. Payload contains selected kids, one week, first names only — no emails or user ids.
8. **Testing:** System A has no test runner; follow the `scripts/*-check.ts` pattern (esbuild bundle + `node:assert`). Add `scripts/display-check.ts` (`toDisplay`, `applyOps` for every op, limits, missing cards, unknown-key preservation, idempotent add by client id, `mergeTicks`); extend `rls-check.ts` for `display_links` and the definer-function grant; extend `sync-check.ts` for the merge hook. System B: `scripts/schedule-check.mjs` (plain node) for `rewritePhotos` and current-section logic. Device: `adb exec-out screencap -p` at 1280×800; grep `dist/*.css` for 4/8-digit hex.

## Interfaces

**Display payload** (System A → frame fn; frame fn rewrites `photo` → `src`):
```json
{"v":1,"updatedAt":"2026-10-13T15:02:11.123456+00:00","week":"2026-10-12","planned":true,
 "can":{"tick":true,"edit":false},
 "kids":[{"id":"k1","name":"Lilly","avatar":{"feeling":"happy"},
   "days":[{"date":"2026-10-12","sections":[{"key":"morning","name":"Morning","words":"Sun is up",
     "cards":[{"id":"c1","icon":"sunrise","photo":null,"label":"Wake up",
               "time":"7:00","length":"","travel":null,"done":false}]}]}]}],
 "icons":{"sunrise":"<path d=\"M12 2v8\"/>…"}}
```
`avatar` is `{"feeling":name}` or `{"photo":{"id","v"}}`; card `icon` xor `photo:{"id","v"}`; `travel` is null or `{"choice":"bike"|"walk"|"car"|null}`.

**Patch request** (frame → System A): `POST {"week":"2026-10-12","ops":[…]}`:
- `{"op":"tick","kid","card","on":true}`, `{"op":"clearDayTicks","kid","day":0}` — Phase 2
- `{"op":"add","kid","day","section","index"?,"card":{"id":"<client 8-char>","picture":{…},"label","time","length","travel"}}` (idempotent by id), `{"op":"remove","kid","card"}`, `{"op":"move","kid","card","toDay","toSection","index"}`, `{"op":"update","kid","card","set":{…}}` — Phase 3

Responses: `200 {display}`; `409 {"error":"gone"|"full"}`; `403` missing scope; `401` revoked/bad token.

## File changes

**System A**
- NEW `supabase/migrations/0002_display_links.sql` — `display_links(id uuid pk default gen_random_uuid(), user_id uuid fk auth.users on delete cascade, label text, token_hash text unique not null, can_tick bool default true, can_edit bool default false, settings jsonb default '{}', settings_rev int default 0, created_at, last_used_at, last_seen_version timestamptz, revoked_at)`; RLS owner select/update/delete. `display_push_document(p_user uuid, p_data jsonb, p_expected timestamptz) returns timestamptz` security definer, CAS on `updated_at`; revoke from public/anon/authenticated, grant to service_role.
- NEW `lib/display/schema.ts`, `view.ts` (`toDisplay`, `iconMarkup`), `patch.ts` (`applyOps`), `token.ts` (`newToken`, `hashToken`, `authLink`), `store.ts` (`loadDoc`, `casWrite`, `touchLink`).
- NEW `app/api/display/schedule/route.ts` (GET, POST), `app/api/display/photo/route.ts` (resize ≤320 px with sharp; `?feeling=`), `app/api/display/pictures/route.ts` (Phase 3), `app/api/display/links/route.ts` (GET list, POST create — session + Origin check like `account/delete`; token returned once), `app/api/display/links/[id]/route.ts` (PATCH, DELETE).
- NEW `components/schedule-v2/frame-panel.tsx` (linked from header or kid menu).
- MOD `lib/sync/use-doc-sync.ts` (optional `merge`), `components/schedule-v2/use-sync.ts` (`merge: mergeTicks`), `lib/schedule-v2.ts` (`mergeTicks`).
- NEW `scripts/display-check.ts`; MOD `scripts/rls-check.ts`, `scripts/sync-check.ts`.

**System B**
- NEW `lib/dhc.js` (`dhcFetch` with env `DHC_ORIGIN`, `DHC_DISPLAY_TOKEN`, 8 s timeout; `rewritePhotos`), `api/schedule.js` (GET/POST), `api/schedule-photo.js`.
- MOD `vite.config.js` (dispatch by method, pass body, register routes).
- NEW `js/schedule-data.js` (`App.schedule = {data, load, poll, tick, patch}`, optimistic + rollback + toast), `js/views/schedule.js`, `css/views/schedule.css`.
- MOD `index.html` (rail button, `#view-schedule`, CSS link), `js/main.js`, `js/app.js` (unpin clock, `App.markDirty`), `js/system.js` (keys 1–8), `js/views/home.js`, `js/views/ambient.js`.
- Phase 3: NEW `js/views/schedule-edit.js` (sheets: picker grid by category + library photos, time chips ±15 min, label preset chips + optional text).
- NEW `scripts/schedule-check.mjs`.

## Phases

**Phase 1 — read-only display, phone → frame**
- A1 migration + `token.ts`/`store.ts` (parallel) — rls-check passes; definer fn not callable as authenticated.
- A2 `view.ts` + display-check (parallel) — hidden/off dropped, unplanned → `planned:false`, only used icons, kid filter.
- A3 schedule GET + photo routes (after A1, A2) — 200 then 304 with ETag; bad token 401; photo ≤320 px.
- A4 links routes + `frame-panel.tsx` (after A1) — token shown once; revoke → 401; "up to date" indicator.
- B1 `lib/dhc.js`, `api/schedule.js` GET, `api/schedule-photo.js`, vite routes (parallel, stub payload) — works in dev; 401 without cookie on Vercel.
- B2 `schedule-data.js` + view + CSS + rail (parallel, fixture) — renders at 1280×800; no banned CSS in dist.
- B3 unpin clock, `markDirty`, home tile, ambient line (parallel) — real time; other views don't rebuild on poll.
- B4 end-to-end on device (after all) — phone edit visible within 60 s.

**Phase 2 — ticks from the frame**
- A5 `patch.ts` tick/clearDayTicks + POST route + checks — unknown keys preserved; lost-race retry; 403 without `can_tick`.
- A6 `mergeTicks` + `useDocSync` merge hook + sync-check.
- B5 frame POST path + optimistic tick with undo toast — Origin mismatch 403; round trip <1 s.
- Device: tick on frame while phone is in kid mode → no dialog later.

**Phase 3 — editing on the frame**
- A7 add/remove/move/update ops + pictures route + kid photo shelf in payload when `can.edit` — limits → 409 `full`.
- B6 `schedule-edit.js` sheets + press-and-hold edit mode.
- B7 up/down reorder + "move to" section chips (no drag-and-drop on WebView 106).

## Owner actions
- Apply `0002_display_links.sql` to Supabase.
- `SUPABASE_SERVICE_ROLE_KEY` present on System A's Vercel env.
- System B Vercel env (Production): `DHC_ORIGIN`, `DHC_DISPLAY_TOKEN`; redeploy.
- Sign in on the phone (magic link) and open Schedule v2 once so planner + photos upload.

## Risks
- Structural edits on both sides at once still raise the phone's conflict dialog (ticks auto-merge).
- Unplanned weeks show empty until opened on the phone ("Start from last week" op could fix later).
- Photo `v` uses `addedAt`; if a photo's bytes change under the same id the frame shows the old one — check `photo-db.ts`.
- Memory with 6 kids × many photos — server resize to ≤320 px; verify on device.
- Kiosk soft keyboard may not appear or may cover sheets — Phase 3 favours chips over typing.
- Server-side patch must track `PlannerSchema` changes; unknown keys preserved and display-check catches drift.
