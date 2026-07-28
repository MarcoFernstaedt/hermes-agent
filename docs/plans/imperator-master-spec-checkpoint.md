# Master Build Prompt v2 — Verification Checkpoint

Decisions in Part 1 are accepted as locked. This is verification, not design.
Answers to Part 16, in order.

## 1. Repo and version — ON-MACHINE, not verifiable from the cloud

The installed Hermes version, profiles, SOUL/context files, skills, kanban, cron
and memory live on the owner's machine; this session runs in an isolated cloud
container. `docs/handoff/imperator-recon-brief.md` collects exactly this. The
prior recon report established: provider `openai-codex` (model `gpt-5.6-sol`) via
OAuth, Spotify/Gmail/Calendar/Telegram/Discord/ntfy/Feishu connected, a real
Obsidian vault at `~/obsidian-vault` (733 notes), and — importantly — **the daily
runtime on :9119 is an older checkout than `main`**. Confirm the Hermes version
is v0.19.0 and redeploy before phase-one work is judged.

## 2. Blockers only

**No blockers in Part 1.** Every locked decision is either already true in the
fork or implementable. Two factual notes, neither a blocker:

- **The stack migration is large but not impossible.** React Aria / TanStack
  Router / SQLAlchemy+Alembic / Pydantic-codegen replace working, tested
  subsystems. Accepted as locked; it is sequenced as incremental replacement
  behind the existing gate (tsc + eslint + vitest + build + pytest green on every
  merge) so the app never regresses mid-migration.
- **`prefers-reduced-motion: reduce` had no global rule** — only the in-app
  setting did. That was a real accessibility defect against Part 10's hard
  requirement. **Fixed in this commit.**

## 3. The two protocols — confirmed by reading the code

- **TUI gateway** (`tui_gateway/server.py`): NDJSON-RPC over stdio/WebSocket.
  Methods: prompt, command, steer, interrupt, session ops. Events:
  `session.info`, `text`, `tool.started`, `reasoning.available`, `*.request`,
  `subagent.*`. The dashboard hosts an in-process gateway on `/api/ws`
  (loopback); `/api/pty` is the xterm bridge; `/api/pub` + `/api/events` is a
  working pub/sub with `_seq` + replay. **Assumption to re-verify on-machine:**
  the exact v0.19.0 method/event catalogue, and that smart-approval verdicts are
  carried on the approval event (the design renders the verdict in the card).
- **Plugin contract** (`hermes_cli/plugins.py`): `PluginContext.register_tool /
  register_hook / register_command`. Dashboard tabs are **separate** —
  `plugins/<name>/dashboard/manifest.json` (tab, entry, optional
  `plugin_api.py` mounted at `/api/plugins/<name>/`). There is **no
  `register_dashboard_tab`**; the manifest is the mechanism. The TSX→IIFE build
  pipeline for rich plugin UI now exists in-repo (`web/plugin-sdk`).

## 4. Byte-stability audit — the careful check, done

**Result: compliant today, and the locked two-tier design matches how the fork
already works.**

- `agent/system_prompt.py` already splits the prompt into **`stable` /
  `context` / `volatile`** parts.
- The only clock-derived content is **date-only**, deliberately:
  `timestamp_line = f"Conversation started: {now.strftime('%A, %B %d, %Y')}"`,
  with an in-code comment stating minute precision would invalidate prefix-cache
  KV on every rebuild path. Byte-stable for a full day.
- The assembled prompt is **cached on `agent._cached_system_prompt` for the
  lifetime of the session** — the module docstring names keeping upstream prompt
  caches warm as the explicit goal.
- **Imperator adds nothing to the system prompt.** Grep across `hermes_cli/` and
  `tools/` finds no fork-side injection: capabilities, the review queue, session
  scopes, agent guards, approval integrity and health are all exposed as
  **tools** and HTTP endpoints, never prompt text.

**Conclusion:** the `hub_context` volatile tier is not a change of direction —
it is the pattern the fork already follows. Rule for every future addition:
structural facts (capability list, module tools) may enter the static tier and
re-warm the cache once, deliberately; anything recency-ordered, timestamped, or
per-turn goes in `hub_context` or the final user turn, never the prefix. A
byte-stability check is now part of the definition of done for prompt work.

## 5. Capability declaration format

Published and enforced: `hermes_cli/capabilities/schema.py` (draft-07 JSON
Schema + a pure-Python cross-reference validator), served at
`GET /api/capabilities/schema`, with `POST /api/capabilities/validate` as the
shared check both authoring paths call.

**Differentiation is already proven, not asserted:** `tasks.json` (lifecycle +
board view) renders as a staged board with drag/keyboard transitions and a stat
row per state; `contacts.json` (no lifecycle, table view) renders as a table.
Same blocks, genuinely different composition, selected deterministically by
`view.kind === "board" && lifecycle ? BoardView : DataTable`.

**Jobs-as-declaration is deliberately not done yet** — Jobs is a rich native page
whose apply-flow and packet assets are Layer-3 (plugin) material, and its
migration is the owner's explicitly last item. Expressing it as a declaration
before the renderer has gallery/calendar views and formula/rollup fields would
downgrade it.

## 6. One block specified state-by-state — the Approval card

Chosen because it is the highest-consequence block in the system: a wrong render
is a security-UX failure, not a cosmetic one.

- **Default (pending)** — kind badge, title, source, and risk. Body shows the
  *artifact*: full text of anything to be sent, exact diff of anything changed,
  the precise list of what will be touched. Never a summary standing in for the
  payload. Accessible name: "Proposal: <title>, <kind>, <risk> risk, pending."
- **With smart-approval verdict** — when Hermes' LLM reviewer has judged the
  command, the verdict and its reasoning render above the actions, labelled as a
  machine judgement, not a human one. I am reviewing a judged proposal.
- **Expanded** — a disclosure widget (`aria-expanded`) reveals the full payload;
  collapsed by default so a long diff never buries the actions. Expansion is
  height-animated at `--transition-panel`; reduced motion makes it instant.
- **Focus** — 2px gold ring, offset 2px, on every interactive element; the card
  itself is not a control, so it is not focusable — its buttons are.
- **Busy (deciding)** — approve/reject disable, the acted button shows a
  determinate-if-possible indicator, focus is retained, and a polite live region
  announces "Approving <title>" once.
- **Applied** — the card settles to a success state naming the outcome
  ("capability 'notes' written"). Announced politely. It leaves the pending list
  on next refresh, never yanked out from under focus.
- **Failed** — error tint, the failure reason rendered in full (not truncated),
  and the proposal stays visible so the reason can be read. Announced
  assertively: this is a failed user action.
- **Rejected** — muted, reason captured and sent with the rejection so the agent
  course-corrects rather than retrying blindly.
- **Stale (decided elsewhere)** — if another client decided it first, the card
  shows the current status and disables actions rather than 409-ing on click.
- **Empty (queue clear)** — "Nothing to review. The queue is clear."
- **Reduced motion** — every transition above becomes an instant state change.
  No information is conveyed by motion alone.

Today's `/review` implements pending/expand/act/applied/failed/empty; the
verdict, stale and reject-with-reason states land with the smart-approvals work
in phase three.

## 7. Where generated will feel generic — honestly

- **Rich bespoke interactions** — the Jobs apply-flow, the Media player, an email
  thread reader, a calendar grid — are **Layer-3 plugins**, not declarations.
  Forcing them through the generic renderer is precisely the "two capabilities
  collapse into one layout" failure the spec forbids.
- **Views the renderer does not have yet**: calendar, timeline, gallery, chart.
  These are renderer extensions built once, not per-capability code.
- **Field types not yet supported**: formula, rollup, computed status, relation,
  geo, file/image. Until they exist, a declaration cannot express them.
- **You will hand-build**: Media, Jobs detail, the calendar grid, the email
  reader, and anything chart-heavy. Everything list/board/table/form-shaped is
  generated, and that is most of the app.

## 8. Phase plan against the locked build order

Effort is rough and assumes the existing gate stays green on every merge.

| Phase | Milestone | Effort | State |
|---|---|---|---|
| 1 | Tokens + motion system + block catalogue | S | **Started here**: full motion band set + composite shorthands + the OS reduced-motion fix landed. Remaining: token reference doc, block gallery gap-fill, React Aria adoption for new overlays. |
| 2 | Core services — entity store, link graph, search, action registry, realtime, jobs, event bus, settings, permissions, audit, files | L | Entity store, link graph, search, realtime (seq+replay), settings, permissions, audit **exist**. Missing: action registry, job queue, event bus, files. |
| 3 | Hermes integration — module SDK, native chat client, agent surfaces | XL | Module SDK + plugin build pipeline **done**. Chat client is the single biggest piece and needs the on-machine model to verify. |
| 4 | Capability API — schema, renderer, dry-run, approval, live registration | M | Schema, renderer, approval **done**. Missing: dry-run plan, live hot-mount, versioning/rollback, renderer breadth. |
| 5 | Modules — email, calendar, vault, jobs, progress, media, research, ingest | XL | Several exist as native pages; migration to plugins is last per standing instruction. |
| 6 | Proactivity, adaptation, health | M | Health **done**. Proactivity/adaptation pending, off by default. |
| 7 | First-run drip | M | Last; composes everything above. |

**Now starting phase one.**
