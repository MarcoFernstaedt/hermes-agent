# Imperator Platform Expansion — Plan

Status: approved for planning; **no feature code until Phase 0 is signed off**.
Owner decisions locked (2026-07): unify all Google access on one service layer;
Media/Spotify is Phase 1; this document is the tracked plan.

This turns the Imperator dashboard from an agent control panel into a personal
operating surface that absorbs a new feature area every few weeks without
collapsing. The governing rule: **every capability is written once in a backend
service and exposed twice — to me through the UI, to the agent through a tool.**
Neither consumer gets a path the other lacks, and no capability logic is
duplicated.

---

## 1. Existing design system (reference — conform, do not replace)

Tokens live in `web/src/index.css` `:root`, mirrored in `web/src/themes/presets.ts`
and the server-rendered `hermes_cli/dashboard_auth/login_page.py`. All three must
stay in sync.

- **Gold** `--midground-base: #e8c87a` (aurum) — the single accent, wired to
  `--color-primary`. Gold marks the one thing that matters on a surface.
- **Obsidian-violet** canvas `--background-base: #0f0b1e`.
- **Violet** `#a78bfa` — secondary / "output" data-series accent.
- Depth = layered obsidian surfaces via `color-mix(gold into obsidian)` at
  4/6/8/10/15%, plus restrained rim light. No heavy blur, no glow.
- `--radius: 0.5rem`; density via `--theme-spacing-mul` (0.9 compact). System
  font stack, 15px base, line-height 1.55.
- Reduced motion: `html[data-motion="reduced"] *` already collapses
  animation/transition in `index.css`.
- **Gap to fix:** there is no single shared spring token. Phase 0 adds
  `--ease-spring` with 120–200ms for state changes and 240–320ms for panels,
  and refactors ad-hoc timings onto it. One orchestrated moment per module;
  everything else quiet; all motion disabled under reduced motion with no loss
  of meaning.
- Primitives from `@nous-research/ui` (external package — never edited).

Constraints held throughout: no emoji in UI, no glassmorphism, no neon, one
scroll region per view, sticky chrome (never scrolling chrome), reserved space
for loading content, contrast ≥ 4.5:1 body / 3:1 UI verified against the real
gold-on-obsidian tokens.

## 2. Existing module structure (formalize, don't reinvent)

The backend already contains this brief's module pattern:

- `hermes_cli/jobs/` and `hermes_cli/life/` are each a package =
  `models.py` + `repository.py` (SQLite data layer) + `router.py` exposing
  `create_<x>_router(authorize, initialize)`, mounted with one
  `app.include_router(...)` line behind the shared `_require_token` gate.
- Agent tools self-register via `tools.registry.register(name, toolset, schema,
  handler, …)`; `model_tools.get_tool_definitions()` assembles the
  model-facing schemas.
- The frontend plugin system (`web/src/plugins/`) is a **runtime loader for
  external JS bundles** (`window.__HERMES_PLUGINS__.registerSlot`, SRI hashes,
  `has_api` manifests). Its **slot registry** is the right mechanism for
  injecting shell widgets (now-playing strip, unread badge); its remote-bundle
  machinery is the wrong mechanism for in-tree modules.

So this work **formalizes and extends an existing pattern** rather than
greenfielding one — materially lower risk than the brief assumes.

## 3. Audit of what already exists

**Media** (`web/src/features/media/`): a source-switcher shell
(`spotify | audiobooks | apple-music`, Apple disabled) with `MediaProvider`,
`PlayerDock`, `media-state`. No Spotify backend, no token store, no `/me/player`.
→ Keep the dock ergonomics + a11y scaffolding; build the whole Spotify service
+ OAuth from scratch; drop `audiobooks`/`apple-music` from v1.

**Jobs** (`hermes_cli/jobs/` + `JobsPage.tsx`): the strongest existing module —
real repository, optimistic concurrency (`expected_updated_at`/`StaleJobError`),
asset store, status transitions. Missing: stage-change history, contacts,
per-app documents, metrics, follow-ups, and agent tools (UI-only today).
→ Extend, don't rebuild.

**Progress** (`hermes_cli/life/` + `ProgressPage.tsx`): backed by a "Life" API —
habits, per-day entries with notes, 14-day history, daily reflections. Missing:
quantitative metrics with targets, streak/rollup logic, multiple horizons,
goals-with-sub-goals, accessible chart→data-table equivalents, agent tools.
→ Extend the `life` module.

**Discovery — Google Workspace skill:** `skills/productivity/google-workspace/`
already does Gmail search/get/send/reply and Calendar list/create, storing a
**single Google OAuth token in plaintext** at `~/.hermes/google_token.json`. The
agent already has Gmail/Calendar capability, and Google data-OAuth already
exists — unencrypted. **Decision: unify.** Email and Calendar modules share one
encrypted token store and one `hermes_cli/google/` service layer that both the
skill and the new UI/agent-tools call; the plaintext token is migrated to the
encrypted store in Phase 0.

## 4. Module contract

One `ModuleDefinition` per area, registered in a single frontend
`web/src/modules/index.ts` and backend `hermes_cli/modules/registry.py`. Adding
a module = one new directory + one line in each registry. Touching more than two
files outside the module directory means the contract is wrong.

```
web/src/modules/<mod>/
  index.ts        # ModuleDefinition: id, nav entry, lazy routes,
                  #   shell-slot components, settings schema,
                  #   command-palette + global-search contributions
  <Mod>Page.tsx
  api.ts          # typed client → own backend ONLY (never Google/Spotify direct)
  store.ts        # uses the shared data/cache layer (no bespoke fetching)

hermes_cli/<mod>/
  __init__.py
  models.py
  service.py      # THE capability — the single implementation
  <provider>.py   # provider adapter; declares rate limits to the sync engine
  router.py       # create_<mod>_router(authorize) → calls service
  tools.py        # registers agent tools → call the SAME service
  settings.py     # module settings schema, merged into the global store
```

A `ModuleDefinition` registers: nav entry + lazy routes; backend router; agent
tools; settings schema; permission/approval requirements; data-access + sync
provider; shell-slot components. `router.py` and `tools.py` both call
`service.py` and contain no logic of their own — "write once, expose twice" is
structural.

**Agent-tool process boundary:** the agent runs in a separate process from
`web_server`. SQLite-only modules (jobs, life, vault index) open the same DB from
both. OAuth-backed modules (email, calendar, media) keep tokens only in the web
server's encrypted store, so **agent tools call the dashboard's own localhost
HTTP API** with the session token rather than re-implementing provider calls.
One service, one token store, one audit path.

## 5. Information architecture

A flat sidebar of ~25 admin pages won't hold six life modules. New top-level
grouping:

- **Do** — Chat, Calendar, Jobs, Progress
- **Read** — Email, Notes (Vault), Media
- **Build** — Sessions, Skills, Learning, Git, Files, MCP, Plugins
- **System** — Models, Config, Keys, Channels, Webhooks, Cron, Logs, Analytics, Settings

Command palette + global search are the primary cross-module navigation (Part 5).
Adding three more modules means dropping each into a bucket or adding a fifth —
the structure doesn't churn. Exact grouping component is proposed before the nav
is touched.

## 6. API feasibility — verified July 2026 (corrections in bold)

- **Spotify Nov 2024:** audio-features/analysis, recommendations, related
  artists, editorial/algorithmic playlists, and preview URLs are gone for apps
  created after 2024-11-27. Confirmed. Design nothing on tempo/energy/recs.
- **Spotify Feb 2026:** batch metadata endpoints removed (no `GET /tracks`,
  `/albums`, `/artists`, `/episodes`, `/shows`); library saves/follows
  consolidated under `PUT|DELETE|GET /me/library` with URIs; playlist items moved
  `/playlists/{id}/tracks` → `/playlists/{id}/items` (`tracks`→`items`,
  `track`→`item`); `GET /me` drops product/email/country/followers/explicit_content;
  tracks drop popularity/available_markets/linked_from; playlist create is
  `POST /me/playlists` only; Dev Mode needs Premium + ≤5 users + 1 client ID.
  Confirmed. Player endpoints survived.
- **Search cap:** brief says `limit` maxes at 10 / default 5. **Not confirmed
  from the changelog** — design the search UI for small pages + `offset`
  regardless, verify against the live API at build.
- **Web Playback SDK mobile:** brief says it doesn't work on mobile. **Outdated
  — it now works with real autoplay/background/interaction limits.**
  Recommendation unchanged and stronger: **Connect-only**, no second SDK.
- **Gmail 7-day token death (Testing + External):** confirmed. Fix = move consent
  screen to **Production** (unverified fine <100 users → indefinite refresh
  tokens). Treat reauth as a normal state regardless: detect `invalid_grant`,
  mark account needs-reconnect, keep cache readable, one-click reconnect.
- **`gmail.modify` vs `mail.google.com`:** confirmed — modify covers
  read/label/archive/trash/drafts/send but not permanent delete; full scope
  avoided. Personal-use / <100-account CASA exception applies.
- **Calendar scopes = sensitive (not restricted):** confirmed, lower bar,
  personal-use exception applies.
- **Google Tasks:** separate API/scope; historically date-only due dates —
  confirm time precision at build before promising it.
- **Gmail/Calendar push** needs public HTTPS + Pub/Sub → **poll `history.list` /
  `syncToken`** for a self-hosted app. Confirmed conclusion.

## 7. OAuth scopes (narrowest that works)

- **Spotify:** `user-read-playback-state`, `user-modify-playback-state`,
  `user-read-currently-playing`, `user-read-recently-played`, `user-library-read`,
  `user-library-modify`, `playlist-read-private`, `playlist-modify-private`,
  `user-top-read`, `user-follow-read`. No `streaming` (Connect-only). Add
  `playlist-modify-public` only if editing public playlists is wanted.
- **Gmail:** `gmail.modify` only. Not `mail.google.com`. Permanent delete not
  offered.
- **Calendar:** `calendar.events` + `calendar.readonly` (calendar list +
  free/busy); confirm free/busy's minimum scope at build and narrow if possible.
- **Google Tasks:** `tasks`.
- **Obsidian:** none (local FS).

## 8. Permission / approval model (enforced in the service layer)

- **Auto (read):** all search/list/read/get; get-playback-state; find-free-time;
  get-progress; player transport (play/pause/skip/queue/volume — reversible).
- **Approval by default; per-tool auto-allow opt-in once trusted (create):**
  create-event, update-event, create-task, create-application, update-stage,
  append-to-note, create-note, append-daily-note, create-playlist,
  add-to-playlist, draft-reply (draft only), log-metric.
- **Always approval, never auto-approvable (destructive/irreversible):** send
  email, trash email, delete/overwrite note, delete calendar event,
  respond-to-invitation (sends), any delete.

Approvals show the full text/target before confirm. Every external write →
append-only audit log (filter + export). Deletes go to trash/backup, never purge.

## 9. Phase plan (one module per phase; each ends shippable)

Effort in t-shirt sizes. Per-module accessibility (automated → keyboard-only →
NVDA in Chrome and Firefox) is done inside each phase and reported per module.

- **Phase 0 — Platform foundation (L):** module registry (FE+BE); shared
  data/cache layer (stale-while-revalidate + request dedup + background
  refetch); sync engine (initial fetch → delta token → full-resync fallback,
  per-provider rate-limit budgets + backoff); encrypted token store + migrate
  the plaintext Google token; permission-tier + audit-log infra; shared spring
  token; route-level code splitting + bundle budgets in CI.
  **Budgets:** initial shell+route ≤ 200 KB gzip; per lazy route ≤ 150 KB gzip;
  TTI ≤ 2.5 s mid-tier mobile. (Today's build is one ~346 KB-gzip chunk — real
  splitting work.)
- **Phase 1 — Media / Spotify (M):** Connect-only; now-playing shell strip;
  transport; queue; device picker; library; search; agent tools (search, play,
  pause, skip, queue, get-state, create-playlist, add-to-playlist).
- **Phase 2 — Email / Gmail (XL, split):** **2a** read/list/search/thread/label/
  archive via `history.list` sync + route-addressable overlay; **2b** compose/
  reply/send/drafts. Unifies with the Workspace skill.
- **Phase 3 — Calendar + Tasks (L):** agenda-first + grid; event CRUD; free/busy;
  tasks. Recurring: single-occurrence + whole-series in v1; **defer
  "this-and-following."**
- **Phase 4 — Obsidian vault (L):** index + render + backlinks + FTS search +
  append/create; atomic writes + backups; filesystem watch. **Full editing and
  graph view deferred.**
- **Phase 5 — Jobs (S):** stage history, contacts, documents, metrics,
  follow-ups→calendar, agent tools.
- **Phase 6 — Progress (S):** metrics+targets, streaks, goals/rollup, accessible
  chart→table equivalents, quick-log from shell/palette, agent tools.

## 10. Scope cuts and risks (things I pushed back on)

- **Offline write-queue-and-replay for external providers is unsafe** as
  specified (double-sends, stale-conflict clobbers). v1: offline = read cached
  only; external writes require connectivity and say so. Local modules
  (jobs/progress/vault) may queue writes safely.
- **"This and following" recurring edits** deferred (truncate rule + new series,
  no API help). Ship single + whole-series first.
- **Full Obsidian editing** deferred (data-loss blast radius). v1 append/create,
  atomic + backups.
- **Graph view** skipped (can't be meaningful by screen reader).
- **Gmail Pub/Sub push, Web Playback SDK, anything on audio-features** — all
  skipped (poll; Connect-only; gone).
- **Email split** read-then-compose; **Media sequenced first** as the lowest-risk
  end-to-end proof of OAuth + sync + agent-tools + shell-slot.
- **Plaintext Google token** is a live security gap — fixed in Phase 0.

## 11. Standing constraints

Server-side OAuth only (tokens never reach the browser, a URL, or browser
storage); tokens encrypted at rest, refreshed on the backend, revocable from the
UI, per-account caches cleared on disconnect; refresh failure is a first-class
reconnect state. No secrets in the bundle, no telemetry, no external CDNs, no
third-party scripts. Email HTML rendered in a sandboxed iframe, scripts off,
remote images blocked until allowed per sender. Vault paths validated against the
root with symlinks resolved. New endpoints sit behind the existing auth gate.
Upstream-Hermes parity preserved; changes grouped for a survivable rebase; no new
dependency without justifying bundle cost and why nothing present suffices; tree
builds/type-checks/lints clean at every phase boundary.
