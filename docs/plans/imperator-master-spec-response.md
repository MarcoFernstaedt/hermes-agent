# Master Build Prompt — Engineering Response (plan, before code)

Answering Part 16, grounded in what the fork actually is (verified by reading it)
and what's already been built. I flag on-machine-only items honestly rather than
guessing, and I push back where the spec is a rewrite of a working app.

## The one thing to internalise first

**A large, load-bearing fraction of this spec is already built and on `main`.**
Before planning a rewrite, the honest map:

| Spec asks for | State in the fork |
|---|---|
| Layer 1 — blocks | Built: `web/src/blocks/*` (BoardView, DataTable, FilterBar, StatBar, FormFromSchema, FieldGrid, RecordHeader, ThreePane) + a `/blocks` gallery. |
| Layer 2 — capabilities (data → fixed renderer) | Built: declaration JSON → `CapabilityArea` fixed renderer; **now schema-validated** before render. Two declarations already render as genuinely different surfaces. |
| Layer 3 — modules as plugins | Built: dashboard-plugin discovery + the **TSX→IIFE build pipeline** (`web/plugin-sdk`, `build-dashboard-plugin.mjs`). |
| Capability authoring (human + agent, one artifact) | Built this session: visual builder (`/capabilities/new`) + `capability_propose` agent tool, both → one validated declaration → review queue. |
| One review queue | Built: `hermes_cli/review/*` + `/review`, per-kind apply handlers, same-origin, audited. |
| Guardrails (Part 14) | Built: session scopes + server-enforced global stop, approval integrity (observe), rate-limit + anomaly + outbound secret-scan, audit log. |
| Health / self-observation (Part 5 System) | Built: `/api/system/health` + Platform health card. |
| Release provenance / upgrade self-check seed | Built: `/api/system/provenance` + drift banner. |
| a11y gate in CI | Built: `auditA11y` tripwire wired into component tests. |
| Realtime multiplex | Partly built: `/api/events` multiplexed with seq + replay. |

So this is **not** a green-field build. The right frame is: *finish the union on
the foundation that exists*, not rewrite it.

## 1. Repo & version recon — ON-MACHINE

I cannot verify the owner's installed Hermes version, profiles, SOUL/context
files, skills, kanban, cron, or memory from the cloud — those live on the
machine. This is exactly what `docs/handoff/imperator-recon-brief.md` collects.
**Action:** the on-machine agent confirms Hermes is v0.19.0 ("Quicksilver",
2026-07-20) and, if older, updates first — several spec features (byte-stable
gateway prompts, smart approvals, live subagent transcripts, MoA-as-models,
reasoning tiers, SecretSource) depend on it. I will not design against features
I can't confirm are installed.

## 2. Capability inventory — see the audit already written

`docs/plans/imperator-dynamic-ui-self-improvement-response.md` has the
Hermes-capability × dashboard-exposure table. Deltas the master spec adds to
verify on-machine: goals+completion-contracts, live delegation transcripts,
`/journey` + memory graph, `/learn`, curator, **MoA presets**, reasoning tiers
(`max`/`ultra`), **smart approvals + deny rules**, **Automation Blueprints**,
**SecretSource** (Bitwarden/1Password), sessions export, profile routing, voice
mode. For each: does v0.19.0 expose it, does the dashboard surface it, where the
surface lives. This is a recon deliverable, not something I fabricate here.

## 3. The chat decision — agreed, structured client on tui_gateway

Confirmed earlier by reading the code: the gateway is NDJSON-RPC
(`tui_gateway/server.py`) with prompt/command/steer/interrupt/session methods and
session.info/text/tool.started/reasoning.available/*.request/subagent.* events;
the dashboard hosts an in-process gateway on a loopback WS (`/api/ws`). **Design:**
a native React client renders structured messages, streamed reasoning blocks,
tool cards, and approval cards as real DOM (correct a11y tree, selectable text),
multi-client via the existing `/api/events` fan-out with seq+replay; the terminal
stays a separate labelled tab. **Blocker:** cannot be E2E-verified here (no model
key in the cloud) — build behind the on-machine gateway; re-confirm the exact
v0.19.0 method/event catalogue first.

## 4. The plugin contract & module SDK — built, one worked example exists

Verified contract: `plugins/<name>/dashboard/manifest.json` (tab + entry +
optional `plugin_api.py`) discovered by the host; agent tools via the plugin
`register(ctx)` or core `tools/*.py`; `window.__HERMES_PLUGIN_SDK__` exposes
React/DS/api to bundles. The **module SDK is the build pipeline + example**
(`web/plugin-sdk/example/`, `docs/dashboard-modules.md`). Worked example end-to-
end already ships and is asserted by `build-pipeline.test.ts`.

## 5. Capability declaration format — written + proven

Full format is `hermes_cli/capabilities/schema.py` (published JSON Schema +
validator). Jobs-as-declaration is not yet done because Jobs is a rich native
page (deferred by owner to last); the *format* is proven by tasks/contacts/
reading, and by the differentiation test (board-with-lifecycle vs table-only).

## 6. Where generated will feel generic — honest

- **Rich, bespoke interactions** (the Jobs apply-flow, the Media player, a
  calendar grid, an email thread reader) are *not* generic-renderer material —
  they're dashboard **plugins** (Layer 3), not capability declarations. Don't try
  to express them as declarations; that's the "collapse into one layout" failure.
- **Calendar / timeline / gallery views** the generic renderer doesn't have yet —
  today it does board + table. Those are renderer extensions (build once), not
  per-capability code.
- **Formula/rollup/computed fields** in the spec's field list don't exist in the
  renderer yet; until they do, a declaration can't express them.
  You'll hand-build: Media, Jobs detail, Calendar grid, the email reader, and any
  chart-heavy surface. Everything list/board/table/form-shaped is generated.

## 7. Caching & the byte-stable-prompt problem (the hard one)

The conflict the spec names is real: an omnipresent agent needs live cross-module
context, but the system prompt must be byte-stable to keep the provider cache.
**Resolution — never put volatile context in the system prompt.**

- **System prompt (byte-stable):** identity, tools, scope — invariant across
  turns. This is what Hermes v0.19.0 already pins; we add nothing that churns.
- **Volatile context (where you are, recent events, review queue, link-graph
  neighbourhood) rides the *turn*** — a compact **digest** assembled per request
  and placed in the user turn / tool results, never the cached prefix. Digest,
  not dump (mirrors Hermes's own auxiliary-model context-digest pattern).
- **Server-side read-through cache** on entity/external reads, invalidated
  precisely by the event bus (a write invalidates its keys, not a broad flush).
- **Client:** the shared `use-data` cache already does stale-while-revalidate +
  dedup; keep one cache, no per-module fetching.
Every system-prompt injection point gets a byte-stability check; if a feature
would churn the prefix, it moves to the turn digest.

## 8. Realtime — extend what exists

`/api/events` is already one multiplexed pub/sub with `_seq` + replay. Finish it:
per-channel subscription (chat, agent status, delegation, kanban, jobs, review,
ingest, sync, health), heartbeats, reconnect-with-since. One connection, not one
per feature. This is a consolidation, not a rebuild.

## 9. Blocks — highest-risk three, and a second worked spec

Highest risk: **DataTable** (virtualization + inline edit + a11y + column ops),
the **Calendar grid** (NVDA/VoiceOver grid semantics are brutal), and the
**Approval card** (must render sent-text/diffs and the smart-approval verdict
faithfully — a wrong render here is a security UX failure). The TTS-button-depth
spec for a second block (the **Approval card** state machine) belongs in the
blocks gallery doc; I'll write it there when that block is built, not invent it
speculatively here.

## 10. Motion — token exists, catalogue to formalise

A shared spring token already exists (task history). Formalise the full
token set + per-animation table (trigger/duration/easing/reduced-motion) as a
`docs/motion.md` when the shell work starts; the discipline (caused-only,
transform/opacity, reduced-motion = instant) is already the mission's rule.

## 11. Accessibility — the gate exists; deepen it

`auditA11y` is the CI tripwire now. The spec's bar (NVDA in Chrome+Firefox,
VoiceOver in Safari, per-module) is **on-machine manual** work — the recon brief
already asks for NVDA passes. In CI: keep axe-equivalent tripwire on every
surface's test; add Playwright a11y snapshots once a browser-driven test lane
exists. Headless primitives: **evaluate React Aria vs Radix before any new
overlay/menu/combobox** — but do not rip out working components to adopt one.

## 12. First-run drip — after the foundation

Reads existing Hermes config (profiles/skills/kanban/cron/memory) → asks a few
voice/keyboard-answerable questions → composes a home dashboard + scaffolds
capabilities (via the *same* review queue) + notification rules + briefing. Built
on the capability authoring + review machinery that now exists. Sequenced late.

## 13–14. Adaptation & security — mostly built or planned

Security (Part 14) is largely **done** (scopes, stop, integrity, rate/anomaly,
secret-scan, audit, server-side secrets). Adaptation (Part 13) is the priority-
only, pin-wins, off-by-default engine from the earlier plan — not yet built,
sequenced late, structure-never-auto.

## 15. Technology — where I disagree (you asked for judgment)

**I do not recommend the Part 15 wholesale swap.** It is a rewrite of a working,
shipped app and would stall every feature above for months with high regression
risk — the opposite of the mission's "compound, don't decay."

- **Keep** the current React + Vite + Tailwind + the existing DS. Adopt libraries
  **incrementally, where they pay for themselves**: `dnd-kit` (accessible DnD for
  boards), `TanStack Virtual` (lists >100 rows), CodeMirror 6 (vault editing),
  a charting primitive (Visx/D3) when charts arrive.
- **Do not** rewrite routing to TanStack Router, state to a new lib, or the
  backend to SQLAlchemy 2.0 + Alembic + Pydantic-single-source now. The
  dependency-free sqlite stores + FastAPI + hand-typed API are working and
  tested. A Pydantic→TS/Zod codegen pipeline is a real idea but a large
  investment for marginal gain over the validated schema layer that exists;
  revisit only if agent-authored *modules* (code) become frequent.
- **React Aria vs Radix:** evaluate for *new* accessible overlays; migrating
  existing ones is not worth the churn.
Net: adopt the spec's **ideas** (typed schemas, virtualization, accessible
primitives, budgets) on the **current stack**, not by replacing it.

## 16. What's over-engineered / what I'd cut

If I could build two-thirds, I'd **cut or defer**: the backend ORM/codegen
rewrite (§15), Postgres-readiness, Gantt/timeline blocks, MoA preset *manager* UI
(expose the models first, build the composer later), offsite encrypted backup +
automated test-restore (periodic snapshots + undo cover v1), full PITR, and the
reflection-report engine. **Keep first** (the load-bearing spine): the native
structured chat client, the omnipresent agent + digest context, the realtime
consolidation, the renderer's missing views (calendar/gallery), and finishing
the review-queue-driven self-extension for skills/MCP (plugins/tools last).

## Phase plan (I agree with your instinct, adjusted for what's done)

0. **Done / on `main`:** blocks, capability API + validation, review queue,
   capability authoring (both paths), guardrails, health, provenance, a11y gate,
   plugin build pipeline.
1. **Hermes integration layer** — native structured **chat client** on the
   gateway (the biggest single piece), presence element, delegation/goals/journey
   surfaces reading real Hermes state. *(needs on-machine model to verify.)*
2. **Renderer breadth** — calendar/gallery/timeline views + formula/rollup
   fields, so more surfaces are generated not hand-built.
3. **Self-extension for skills → MCP → plugins/tools** (rising blast radius; the
   plugin/tool approval surface with dry-run last).
4. **Realtime consolidation + the omnipresent agent** (digest context, event-bus
   proactivity into the review queue).
5. **Proactivity, adaptation, first-run drip, cost/MoA surfaces** — last, off by
   default.
6. **Media & Jobs migration to plugins** — the very end, per standing instruction.

Everything in phases 1–5 leans on the phase-0 foundation that already exists — a
deliberate, honest checkpoint, not a fresh start.
