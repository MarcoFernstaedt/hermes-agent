# Dynamic UI, Full Utilisation & Self-Improvement — Response (plan, verified)

Answering Part 6, grounded in the current build (verified by reading the code,
not assumed). Nothing here is built yet — this is the plan.

## Part 1 account — how a declaration becomes a surface today

**Verified: rendering is pure composition. No inference in the render path.**

The path, end to end:

1. Declarations are JSON in `hermes_cli/capabilities/definitions/*.json` (+ each
   plugin's `dashboard/capability.json`), loaded by
   `hermes_cli/capabilities/declarations.py` and served read-only at
   `GET /api/capabilities`.
2. The SPA fetches them once (`web/src/capabilities/useCapabilities.ts`) and
   derives routes + nav from the data — no per-capability code.
3. `web/src/capabilities/CapabilityArea.tsx` is the **single fixed renderer**. It
   reads the declaration and composes fixed blocks from `web/src/blocks/`
   (`BoardView`, `DataTable`, `FilterBar`, `StatBar`, `FormFromSchema`,
   `LinkPanel`). View selection is deterministic:
   `view.kind === "board" && lifecycle ? <BoardView…> : <DataTable…>`. Data comes
   from `/api/entities`; there is **no model call anywhere in this component**.

**Proof it does not generate at render time:** `CapabilityArea` imports React,
fixed blocks, and the api client only. Its logic is `capability-model.ts` pure
functions (`defaultView`, `boardColumns`, `tableColumns`, `countByState`,
`stateLabels`) — all unit-tested, all deterministic. The only network calls are
entity reads/writes. Showing a capability costs one entity fetch and zero
inference.

**Proof two capabilities render as different surfaces:** `tasks.json` declares a
`lifecycle` and a `board` view → it renders as a staged board (plus a table
view). `contacts.json` has no lifecycle and only a `table` view → it renders as a
table. Same blocks, same visual language, genuinely different composition, driven
entirely by the declaration.

**The one real defect (Part 1's own priority):** there is **no schema
validation** of a declaration before it renders. `declarations.py` loads JSON and
trusts it; a malformed declaration would fail as broken UI at view time, not at
author time. Part 1 explicitly requires the opposite. **This is the first thing
to fix**, and it is the precondition for Parts 2–4 (authoring, self-extension,
self-improvement all produce declarations that must validate before they apply).

### Fix, sequenced first

1. **Publish a declaration JSON Schema** (`hermes_cli/capabilities/schema.py` +
   `GET /api/capabilities/schema`) describing entities, fields, lifecycle, views,
   actions, tools — the exact shape `capability-model.ts` already assumes.
2. **Validate on load and on author.** `declarations.py` validates every
   declaration against the schema at load; an invalid one is rejected with a
   clear error and never served. The authoring tool (Part 2) validates before
   write. Same schema, one source of truth, shared by the visual builder and the
   agent tool.
3. **A frontend guard** so an unknown `view.kind` or missing field degrades to a
   labelled "unsupported view" block, never a crash — belt and braces.

No model enters the render path in any of this. The model is involved only when
*authoring or changing* a declaration (Part 2).

## Part 2 — the declaration authoring loop (design)

The artifact is one validated declaration; two authoring paths, identical
guarantees.

- **Visual capability builder** (`/capabilities/new`, a dashboard surface):
  define entities, fields, lifecycle, views through the UI, fully keyboard/NVDA
  operable, with a **live preview rendered by the same `CapabilityArea`** against
  an in-memory declaration — so preview == ship. On save it validates against the
  published schema, writes a versioned declaration, and (for agent-proposed ones)
  routes through the review queue.
- **Agent tool** (`capability_author`): the agent emits a declaration document
  (never UI). It runs through the *same* schema validation and the *same* review
  queue — no weaker path. The agent proposes; the owner approves the diff.
- **Versioned + diffable + rollback:** declarations get a version and history;
  changing a feature is editing its declaration and approving the diff; rollback
  restores a prior version. Stored under the entity store (same backup/export).
- **Library** with clone-as-start: browse your declarations, duplicate one as a
  starting point.

## Part 3 — self-extension flows (design; plugin/tool creation in full)

The invariant everywhere: **the agent proposes → the owner sees exactly what will
run and what it can touch → the owner approves → then it happens.** This rides the
guardrails already shipped (permission tiers, the global stop, session scopes,
approval integrity, the audit log) and the **review queue** built in Part 4.

**Plugin / tool creation — the highest-risk capability. The approval surface:**

When the agent proposes a plugin or tool, it creates a **proposal** (never files
on disk, nothing enabled). The review-queue entry shows, before anything is
written:

- **The exact code** that will run — full diff of every file (`plugin.yaml`/
  manifest, `plugin_api.py`, `dashboard/src/*`, tools), syntax-highlighted, not a
  summary.
- **The complete permission request** — every tool it registers and each tool's
  tier; every toolset/route/hook it touches; every network egress and filesystem
  path it can reach; every secret/credential it asks for. Anything not declared
  is denied at runtime.
- **A capability-diff** — "this adds tools X, Y at APPROVAL tier; mounts
  `/api/plugins/<name>/`; reads `~/x`." Destructive tiers stay ALWAYS_APPROVAL and
  are **never** auto-trustable.
- **A dry-run** — the plugin is loaded in an isolated, disabled state and its
  registration validated (schema, permissions, no tier escalation) without being
  enabled or exposed.

Only on explicit approval is the code written and the plugin **enabled**; the act
is audited with the approved code's hash (approval integrity extends here).
Nothing is ever enabled silently, and approval of the *proposal* is distinct from
approval of each *runtime* action the plugin later takes.

**Skills:** a first-class "propose a skill" path (from a task just done, material
pointed at, or a noticed pattern) → review queue → the curator's library.
Surface the curator's review/archive/prune. Lower blast radius than plugins
(skills are instructions, not code that self-registers tools), but same
propose→approve shape.

**MCP servers:** propose a server + connection + keys → shown for approval →
tested in a sandbox before trusted → then registered. Keys stay server-side.

**Capabilities/automations:** per Parts 1–2 and the automation engine — proposed
structure, approved, then the app reshapes.

## Part 4 — self-improvement machinery (design)

- **Self-observation** (`hermes_cli/telemetry_local.py` + a `usage_events` table
  in the entity store): which surfaces open, which never do, which actions fail,
  where errors cluster, what is slow (against the perf budgets), which
  capabilities/skills are stale/unused. **Local, private, the owner's**, under the
  same backup/export/wipe — this obeys the no-telemetry rule (nothing leaves the
  machine).
- **A health surface** (`/system` gains a "Platform health" panel, or a dedicated
  capability): perf vs budgets, error rates, dead surfaces, unused
  capabilities/skills, sync failures, backup-verification status, anything
  degrading. The app can tell you how it is doing.
- **Improvement proposals, gated:** from that data the platform files proposals
  into the **same review queue** the agent uses — "retire this dead capability",
  "this skill hasn't loaded in months", "this view errors often", "these two
  trackers overlap, merge them", "this surface breaks its budget". Approve/defer/
  reject. The platform suggests maintenance; the owner decides.
- **Regression safety (load-bearing):** every capability change, generated
  surface, and agent-authored plugin runs through **schema validation +
  automated accessibility checks** before it can apply. Add `axe-core` +
  Playwright keyboard/`@axe-core` passes to the pipeline (none exist today) so a
  change that breaks a budget, fails axe, or breaks NVDA is refused at author
  time. This is what makes self-modification safe rather than slow decay.
- **Learning from failure:** an approval that couldn't execute, a broken sync, a
  tool that errored → recorded as a pattern and surfaced as a proposal to fix the
  cause, so a recurring failure becomes one visible item, not repeated noise.
- **Nothing self-applies:** priority/layout adapt automatically and reversibly
  (the adaptive layer); structure/capabilities/skills/plugins/fixes are always
  proposed and approved.

## Capability-utilisation audit (Imperator vs Hermes)

Legend: **uses** = agent can invoke it · **exposed** = app surfaces its controls.
Verify the "?" rows against the installed version + `llms.txt` on-machine.

| Hermes capability | Agent uses | App exposes | Gap to close |
|---|---|---|---|
| Chat via tui_gateway | yes | yes (`/chat`) | — |
| Sessions + cross-session recall | yes | yes (`/sessions`, search) | ask-across-everything surface |
| Kanban (durable queue) | yes (core tools) | yes (plugin) | multiple boards; goals/cron links |
| Delegation (`delegate_task`) | yes | partial | live tree UI + honest non-durability |
| Cron / scheduled jobs | ? | yes (`/cron`) | connect run history ↔ skills ↔ goals |
| Skills + curator | yes (`skill_manage`) | yes (`/skills`) | **propose-a-skill** flow; curator review surface |
| Plugins | n/a | yes (`/plugins`) | **agent-authored plugin** proposal + approval surface |
| Tools (registry) | yes | partial | agent-authored tool proposal flow |
| MCP servers | ? | yes (`/mcp`) | **propose-an-MCP** flow; sandbox test |
| Memory / user model | yes (tools) | partial | browsable/editable, consent-aware pending writes |
| Context files (per profile) | ? | ? | "what's injected now", editable |
| Capabilities (entity store) | list/get/create/advance | yes (boards) | **authoring** (Part 2) + schema validation |
| Voice (STT/TTS) | n/a | yes | real-time voice from the palette everywhere |
| Providers / routing / pools | n/a | yes (keys/models) | routing table + fallbacks + mid-session switch control |
| Terminal backends | yes | partial | health + switching control |
| Computer-use / browser | yes | partial | inspectable artifacts |
| Code execution | yes | partial | inspectable artifact view |
| Profiles (4) | yes | yes | unambiguous write-target everywhere |
| Portal tool bundle | ? | ? | routing table visible |
| Audit log / guardrails | n/a | partial | health + guardrail visibility (scopes shown ✓) |

Shipped this program already: capability boards, entity store + links, session
scopes + global stop, approval integrity (observe), agent guards, release
provenance, the Jobs "Today" surface, and the **TSX→plugin build pipeline** that
makes rich modules removable.

## What's over-engineered / unsafe, and sequencing

**Sequence (safety and the render-path truth first):**

1. **Declaration schema + validation** (Part 1 fix). Precondition for everything;
   cheap; removes the one real Part-1 defect. **Do first.**
2. **Review queue** — the single gated inbox all proposals flow through
   (self-extension, self-improvement, automations). Build once; everything reuses
   it. Read-only proposals, nothing executes without approval.
3. **Accessibility + validation gate in the pipeline** (axe + keyboard passes).
   Must exist *before* self-authoring can apply anything, or self-improvement can
   silently regress a11y.
4. **Agent capability-authoring tool + visual builder** (Part 2) on top of 1–3.
5. **Self-observation + health surface** (Part 4), shipped **read-only first**.
6. **Self-extension: skills → MCP → plugins/tools**, in rising blast-radius order.
   Plugin/tool creation last, behind the full approval surface + dry-run.
7. **Alive/realtime consolidation** (Part 5) — one shared connection, presence
   element, caused motion. Partly built (multiplexed `/api/events`, persistent
   agent-status element); finish and unify.

**Over-engineered / to constrain:**

- **A general "generate any UI" engine** beyond the declaration model. Don't. The
  fixed-renderer + blocks + declaration is the whole point; a freeform generator
  reintroduces exactly the unaccountable render-time generation Part 1 forbids.
  If a declaration can't express something, extend the renderer/catalogue once.
- **ML for self-observation.** Rules over decay-weighted counts, explainable by
  construction — same discipline as the usage-adaptation engine. No black box.
- **Full NVDA-in-CI now.** axe + automated keyboard passes are the affordable,
  high-value gate; scripted NVDA is heavy — keep NVDA as the manual acceptance
  check per release, automate axe/keyboard.

**Unsafe if rushed:** agent-authored **plugins/tools**. This is the one place the
agent writes code that runs. It ships last, only after the review queue, the
dry-run/isolation, and the approval surface that shows exact code + full
permission request exist — and destructive tiers stay ALWAYS_APPROVAL, never
auto-trustable.

Deferred by owner instruction until the very end: migrating Media and Jobs from
native pages to plugins (the pipeline now exists; migration is last).
