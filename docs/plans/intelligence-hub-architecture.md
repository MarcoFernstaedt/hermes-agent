# Imperator Intelligence Hub — Architecture Plan (v3 response)

Status: **planning only — no code written yet** (per brief Part 14, "Do not build yet").
This is the reply that must land before implementation.

The brief describes three layers — **Blocks**, **Capabilities**, **Modules** — over a
set of core services, with an ingest inbox, pipelines, research objects, and a mandate to
surface every latent Hermes capability. This document answers the ten things Part 14 asks
for, in order, and tells you honestly where I disagree and what I'd cut.

---

## 0. The one-paragraph shape of it

We already have, working and merged: a chat feed wired to a real agent PTY, a module
registry (frontend + backend), an encrypted token store, a tiered-permission + audit
layer, an SWR-lite data cache, motion tokens, and five real feature modules (Media,
Email, Calendar, Vault, Jobs/Life). The v3 brief is not asking us to throw that away —
it's asking us to grow a **spine** (an entity store + link graph + action registry +
event bus) so that new working areas can be declared instead of hand-built, and so the
things Hermes can already do (goals, kanban, delegation, memory, skills, cost) get
surfaces instead of hiding in chat. The right move is to build the spine under the
existing modules first (proving parity), then let the Capability API generate the *next*
module, not to rewrite the five we have.

---

## 1. Block catalogue

A **Block** is a presentational, capability-agnostic UI piece with a typed prop contract
and zero knowledge of the entity store. Blocks are the vocabulary the Capability renderer
draws from. They live in `web/src/blocks/`, each with a story-style demo route and a prop
schema.

### Catalogue (v1 — 18 blocks)

**Layout & shell**
- `SplitPane` — resizable, persisted ratio, min/max, keyboard-resizable.
- `ThreePane` — list / detail / context, the desktop workhorse (Vault already needs it).
- `Toolbar` — left/center/right slots, overflow menu, density-aware.
- `CommandBar` — the ⌘K surface as a reusable block (we have one palette; generalise it).

**Collections**
- `DataTable` — virtualised rows, column resize/reorder/hide, sort, multi-select,
  inline-edit cells, sticky header. (TanStack Table + Virtual under the hood.)
- `BoardView` — kanban columns, dnd-kit drag between columns, WIP limits, column collapse.
- `ListView` — dense selectable list with grouping and section headers.
- `CalendarGrid` — month/week/agenda, event blocks, drag-to-reschedule.
- `Gallery` — media/card grid with lazy thumbnails.

**Record**
- `RecordHeader` — title, status pill, breadcrumb, action row.
- `FieldGrid` — label/value pairs driven by a field schema, inline-editable.
- `LinkPanel` — related entities from the link graph, grouped by relation.
- `ActivityFeed` — audit/event stream for one entity.
- `Timeline` — chronological events with lanes.

**Input & feedback**
- `FormFromSchema` — RHF + Zod form generated from a field schema.
- `FilterBar` — declarative filter chips → query predicate.
- `InspectorDrawer` — right-side slide-over for quick edit without leaving the list.
- `EmptyState` / `StatBar` — the small stuff that makes generated surfaces not feel bare.

### The three highest-risk blocks (where generated UIs will feel generic if we get them wrong)

1. **`DataTable`** — This is the block that carries the whole "declared area feels real"
   promise. If inline editing, virtualisation, column persistence, and multi-select
   aren't *genuinely* good, every generated area feels like a spreadsheet toy. Highest
   engineering cost, highest payoff. Build this first, over-invest in it.
2. **`FormFromSchema`** — The moment a field type isn't handled (a date range, a
   reference to another entity, a tag set), the generated form breaks the illusion. The
   risk is the long tail of field types. Mitigation: a small, closed set of field types
   in v1 (text, number, select, date, reference, tags, markdown) and a documented escape
   hatch (`custom` field → module-provided component).
3. **`BoardView`** — Kanban is where Hermes' existing goals/tasks want to live, and drag
   interactions are where "desktop-class" is won or lost. dnd-kit is right, but the risk
   is state reconciliation with the sync engine (optimistic drag vs server truth).

The generic-feeling risk everywhere else is **spacing, empty states, and copy** — a
generated area with good data but a bare header and a default empty state reads as
scaffolding. Budget design time for `RecordHeader`, `EmptyState`, `StatBar` even though
they're small.

---

## 2. Capability API — declaration format

A **Capability** is a JSON/YAML document that fully describes a working area: its entity
type(s), fields, lifecycle (statuses + allowed transitions), relations, views, and
actions. The renderer turns it into a route, a nav entry, list+record surfaces, forms,
and — critically — an **agent toolset**, from the *same* document. Written once, exposed
twice.

### Format (the jobs tracker, expressed fully)

```yaml
capability: jobs
version: 1
label: Jobs
icon: briefcase
group: do

entity:
  name: job
  plural: jobs
  title_field: title
  fields:
    - { name: title,     type: text,      required: true }
    - { name: company,   type: text }
    - { name: status,    type: status,    ref: lifecycle }
    - { name: url,       type: url }
    - { name: salary,    type: number,    format: currency }
    - { name: notes,     type: markdown }
    - { name: applied_at,type: date }
    - { name: contact,   type: reference, to: contact }   # link graph edge
    - { name: tags,      type: tags }

lifecycle:
  field: status
  states: [saved, applied, screening, interview, offer, rejected, archived]
  initial: saved
  transitions:
    - { from: saved,     to: applied }
    - { from: applied,   to: [screening, rejected] }
    - { from: screening, to: [interview, rejected] }
    - { from: interview, to: [offer, rejected] }
    - { from: "*",       to: archived }

views:
  - { id: board, block: BoardView, group_by: status, default: true }
  - { id: table, block: DataTable, columns: [title, company, status, salary, applied_at] }
  - { id: record, block: ThreePane, panels: [FieldGrid, ActivityFeed, LinkPanel] }

actions:
  - id: advance
    label: Advance stage
    kind: transition          # uses lifecycle
    permission: state         # tiered-permission level
  - id: archive
    label: Archive
    kind: transition
    to: archived
  - id: create
    kind: create
    permission: state
  - id: delete
    kind: delete
    permission: always_approval   # destructive → never auto-approvable

agent:
  expose: [list, get, create, advance]   # NOT delete — fail-safe stays manual
  toolset: jobs
```

### What that single document generates

- **Route** `/jobs` + a nav entry in group `do`.
- **List surfaces**: a kanban `BoardView` grouped by `status` (default) and a `DataTable`.
- **Record surface**: `ThreePane` with editable `FieldGrid`, `ActivityFeed` from the
  event bus, `LinkPanel` showing the linked `contact`.
- **A form** (`FormFromSchema`) from the field list, with the right widget per type.
- **Lifecycle enforcement**: server rejects illegal transitions; the UI only offers legal
  ones; the agent's `advance` tool is constrained to legal transitions too.
- **Agent tools**: `jobs.list`, `jobs.get`, `jobs.create`, `jobs.advance` — registered in
  the existing `tools/registry.py`, reads at AUTO tier, create/advance at APPROVAL,
  `delete` deliberately *not* generated (fail-safe to ALWAYS_APPROVAL, consistent with the
  line we've held on send/delete).
- **Audit + permission** wiring for free, because actions carry a `permission` level.

### Where generated surfaces will feel generic (and the honest mitigation)

They'll feel generic in exactly three places:
1. **Empty states** — a fresh area with no records. Fix: every capability may declare an
   `empty` block (headline + primary action); default is decent but plain.
2. **The record header** — generated headers are just title + status. Fix: allow a
   `header` hint (subtitle field, key stats to surface in a `StatBar`).
3. **Cross-entity context** — the `LinkPanel` is only as good as the link graph is
   populated. A capability with no relations feels like an island. This is a data problem,
   not a rendering one, and it's why the link graph is a core service, not a nicety.

I am **not** going to pretend the generated UI will feel bespoke. It will feel like a
*very good admin tool* — which for jobs, reading list, habits, expenses, CRM, is exactly
right. When a surface genuinely needs bespoke interaction (the media player, the email
reader), that's a **Module** (§3), not a Capability. Knowing which is which is the whole
discipline.

---

## 3. Module manifest

A **Module** is a Capability **plus code** — custom blocks, custom routes, a backend
router, and its own migrations — installable and removable as a unit. Media and Email are
modules, not capabilities, because they need bespoke UI (a player, a sandboxed reader) and
external I/O (Spotify, Gmail OAuth) that no declaration can express.

### Manifest (the email example)

```yaml
module: email
version: 1
requires:
  core: ">=1.0"
  services: [entity_store, event_bus, token_store, realtime]
capability: ./email.capability.yaml   # optional: modules may also declare entities
provides:
  routes:
    - { path: /email, element: ./EmailPage.tsx }
  blocks:
    - ./blocks/ThreadReader.tsx        # bespoke, sandboxed iframe reader
    - ./blocks/Composer.tsx
  shell_slots:
    - { slot: nav-badge, component: ./UnreadBadge.tsx }
  backend:
    router: hermes_cli.email.router:create_email_router
    migrations: ./migrations
  agent_tools: hermes_cli.email.tools     # gmail.list/get/thread/draft (NOT send)
permissions:
  - { tool: "gmail.*",  reads: auto, writes: approval, send: always_approval }
settings:
  defaults: { signature: "", images_blocked: true }
lifecycle:
  install: ./install.py      # register OAuth scopes, run migrations
  uninstall: ./uninstall.py  # revoke tokens?, drop tables (with confirmation)
  health: ./health.py        # is OAuth connected, is token valid
```

Key properties: a module **declares its service dependencies** (so install can fail fast
if a core service is missing), **declares its permission surface** (so the tiered model
knows about `gmail.send` before the agent ever calls it), and **owns its migrations** (so
uninstall is clean). Removal is real: drop the route, unregister tools, run `uninstall.py`.

---

## 4. Workflow / pipeline declaration format

A **Workflow** describes a multi-stage pipeline with bottleneck detection over entities of
one capability — the "pipelines/bottlenecks" ask. It's a thin declaration on top of a
capability's lifecycle.

```yaml
workflow: hiring_pipeline
over: job
stages: [saved, applied, screening, interview, offer]   # subset/order of lifecycle
metrics:
  - { id: age_in_stage,   kind: duration_since_last_transition }
  - { id: conversion,     kind: transition_rate, from: applied, to: interview }
bottleneck:
  rule: age_in_stage > 14d     # flag entities stuck too long
  surface: badge               # show a warning badge on the board card
views:
  - { block: BoardView, annotate: [age_in_stage, bottleneck] }
```

This reuses the event bus (transitions are events → durations and rates are derived) and
the `BoardView` block (annotations render as card badges). One example is enough to prove
the shape; I would **not** build a general workflow engine in v1 (see §10, cuts).

---

## 5. Technology recommendations — with disagreements

The brief proposes a stack. Here's where I agree, and where I'd push back.

| Area | Brief | My call |
|---|---|---|
| Headless UI | React Aria **or** Radix | **Radix** for us. React Aria is more complete but heavier and slower to compose; we already lean on `@nous-research/ui`. Use Radix primitives only where that library has a gap. Don't adopt both. |
| Router | TanStack Router | **Agree**, but migrate incrementally — keep the current router until the Capability renderer needs typed nested routes. Not a day-one rewrite. |
| Data | TanStack Query | **Partly disagree.** We built `useData`/`data-cache` (SWR-lite) and it works. Swapping to TanStack Query is a real cost for marginal gain *today*. Adopt it **when** we need mutations + optimistic + invalidation graphs for generated CRUD — which the Capability API does need. So: yes, but as part of Phase 3, not Phase 0. |
| Table | TanStack Table + Virtual | **Strongly agree.** This is the engine under `DataTable`. Non-negotiable. |
| DnD | dnd-kit | **Agree.** Under `BoardView`. |
| Animation | Motion (Framer) | **Disagree on default.** We have CSS motion tokens + reduced-motion kill-switch and a bundle budget. Motion is ~40KB and easy to over-use. Keep CSS for state/panel transitions; reach for Motion only for the few genuinely spring-physics interactions (drag ghosts, reorder). Budget-gated. |
| Forms | RHF + Zod | **Agree.** This is exactly what `FormFromSchema` needs. Zod also becomes the shared field-schema type between front and back. |
| Editor | CodeMirror 6 | **Agree** for the markdown/code fields; **do not** pull it into the initial bundle (lazy per field). |
| Markdown | unified/remark | **Agree**, already the direction in Vault's reader. |
| Charts | Visx | **Defer.** Visx is low-level and a time sink. For v1 metrics/bottleneck badges we need numbers and bars, not a charting framework. Add Visx only when Progress/analytics genuinely needs custom viz. |
| Backend ORM | SQLAlchemy 2.0 + Alembic | **Agree, and important.** The entity store needs real migrations. This is the biggest backend investment and the right one. |
| Validation | Pydantic v2 | **Agree.** Already in FastAPI's orbit. Zod (front) ↔ Pydantic (back) generated from one field schema is the goal. |
| Search | SQLite FTS5 | **Agree.** Cheap, local, no new service. Perfect for the ingest inbox + entity search. |

**Summary of disagreements:** don't adopt TanStack Query, Motion, or Visx on day one, and
pick Radix over React Aria. Everything else, yes. The through-line: adopt heavy deps *when
a concrete surface needs them*, gated by the bundle budget we already enforce.

---

## 6. Realtime architecture

We already have `/api/events` with seq/replay feeding the chat feed. The v3 hub needs
realtime for *entity changes*, not just agent output. Design:

- **One event bus, server-side** (in-process pub/sub over SQLite-backed append log). Every
  entity mutation, transition, and action emits an event with a monotonic `seq`.
- **One transport**: keep the existing SSE-style `/api/events` stream, extended with topic
  filtering (`?topics=entity:job,agent`). SSE over WebSocket because it's simpler, survives
  proxies, auto-reconnects, and we already have replay-by-seq. WebSocket only if we later
  need client→server streaming (we don't yet).
- **Client**: one connection, fanned out to subscribers by topic. The `data-cache` layer
  subscribes to `entity:*` topics and invalidates/patches cached queries on matching events
  — this is how a generated list updates live when the agent creates a record.
- **Ordering & replay**: every client tracks last-seen `seq`; reconnect replays the gap.
  Already proven in the chat feed; generalise the same mechanism.
- **Optimistic reconciliation**: UI mutations apply optimistically, then reconcile against
  the authoritative event (drag on a board, inline table edit). The event carries the final
  server state; the optimistic patch is replaced, not merged.

No new infra, no message broker. The event log *is* the audit log's sibling — same append
discipline, different retention.

---

## 7. Hermes capability inventory (exposed / partial / ignored)

What the underlying Hermes agent can already do, and where it currently surfaces:

**Exposed (has a real UI surface):**
- Chat / streaming / steer / queue / background — the chat feed (rich, live, real `/queue`).
- Slash commands — registry-backed palette + composer.
- Media control (Spotify) — full module.
- Email read / draft — module (send deliberately manual).
- Calendar read / create — module.
- Vault notes read / create — module.
- Tool approvals + audit — permission tiers + audit log endpoints.

**Partial (works in the agent, thin or chat-only surface):**
- **Goals** — the agent tracks goals; no dedicated board. → becomes a Capability (kanban).
- **Kanban / tasks** — exists in Life/Jobs; not generalised. → the `BoardView` block + a
  tasks capability.
- **Cost / token usage** — tracked internally; no dashboard. → a Progress surface (numbers
  first, Visx later).
- **Memory** — the agent has memory; no browsable UI. → a Capability over memory entities
  + FTS5 search.
- **Skills** — discoverable in the agent; no catalogue UI. → a read surface listing skills.

**Ignored (agent can, we show nothing):**
- **Delegation / sub-agents** — the agent can spawn/delegate; no visibility into the tree.
  → an ActivityFeed/Timeline of delegated runs (real value, real work).
- **Voice** — not surfaced at all. → out of v1 scope (see cuts).
- **Per-run cost breakdown** — internal only. → folds into Progress.

The migration principle: **partial** capabilities get a generated surface via the
Capability API (cheap, proves the API), **bespoke** ones stay modules, **ignored** ones get
prioritised by value — delegation visibility first, voice last.

---

## 8. Migration plan (proving parity survives)

The spine goes in *under* the five working modules without changing their behaviour, then
we cut over one module to prove the API, then generate a new one.

1. **Entity store as a parallel backend.** Stand up SQLAlchemy 2.0 + Alembic + the entity
   tables. Do **not** move Email/Calendar/Vault onto it yet — they own external systems.
   The store's first tenants are *internal* entities (jobs, tasks, goals, memory).
2. **Shadow-write, then read.** For the Jobs/Life module (which is already ours, no external
   API), write to both the old store and the entity store, diff them in tests, then flip
   reads. This is the parity proof: Jobs behaves identically, byte-for-byte in tests, on the
   new spine.
3. **Express Jobs as a Capability declaration** and render it from the declaration. If the
   generated Jobs area matches the hand-built one on the parity test suite, the Capability
   API is real. If it doesn't, the gap list is the block/renderer backlog.
4. **Only then** generate a *new* capability (reading list, or goals) that never had a
   hand-built version — the true test of "declare, don't build."
5. External modules (Email/Calendar/Vault/Media) **stay as modules**, unchanged, wired to
   the event bus so their activity shows up in feeds. They are never forced onto the entity
   store; the vault especially stays Obsidian's, never the app's data store.

Parity is a test suite, not a vibe: the existing 221 web + ~75 Python tests stay green at
every step, plus a new shadow-diff suite for step 2.

---

## 9. Phase plan

Ordered so each phase is independently valuable and nothing is a big-bang.

- **Phase A — Blocks foundation.** `DataTable`, `FormFromSchema`, `BoardView`, `ThreePane`,
  `RecordHeader`, `FieldGrid`, `LinkPanel`, `EmptyState`, `StatBar`, `FilterBar`. Each with
  a demo route and prop schema. Adopt TanStack Table+Virtual, dnd-kit, RHF+Zod here. Bundle
  budget enforced per block (lazy). **Deliverable:** a blocks gallery, no capabilities yet.
- **Phase B — Core services.** Entity store (SQLAlchemy/Alembic), link graph, action
  registry, event bus (generalise `/api/events` with topics), FTS5 search. Wire the event
  bus into the existing modules read-only. **Deliverable:** internal entities are storable,
  linkable, searchable, and emit events; existing modules unchanged.
- **Phase C — Capability API.** The renderer that turns a capability YAML into route + nav +
  views + form + agent tools. Adopt TanStack Query here (mutations/optimistic). Prove it by
  expressing **Jobs** as a declaration and passing the parity suite (§8 steps 2–3).
- **Phase D — Generate new areas + surface Hermes.** Reading list / goals / tasks / memory
  as pure declarations. Delegation visibility. Cost/Progress numbers. Ingest inbox (staging)
  as a capability with a review action.
- **Phase E — Modules-as-manifests.** Formalise the manifest, make Email/Media installable/
  removable, document module authoring. Workflow declaration (bottleneck badges) on Jobs.
- **Phase F — Desktop polish.** Interaction/motion pass (Motion only where earned), density
  controls, keyboard-everywhere, the small-copy/empty-state sweep that keeps generated areas
  from feeling generic.

Merge to `main` at every green phase, as we've been doing.

---

## 10. What is over-engineered — the 4 of 14 to drop (for v1)

The brief has 14 parts. I'd cut or defer these four as over-engineered for a single-user
desktop hub:

1. **General workflow/pipeline engine (Part: pipelines/bottlenecks) — DROP to a thin
   declaration only.** A full engine (parallel stages, joins, SLA policies, escalation) is
   enterprise BPM. For one user, "flag cards stuck > N days" is a derived metric on the
   event log (§4). Keep the *badge*, drop the *engine*.
2. **Research objects as a first-class layer — DROP into "just another capability."** A
   research object is an entity with links, notes, and a status. It does not need its own
   layer alongside Blocks/Capabilities/Modules; it's a capability declaration. Elevating it
   is architecture for architecture's sake.
3. **Voice — DEFER out of v1 entirely.** High cost (audio pipeline, permissions, latency),
   low daily value for a desktop hub, and orthogonal to the spine. Revisit after the hub is
   real.
4. **Full permissions matrix / multi-user roles — DROP to the single-user tiered model we
   already have.** The brief gestures at a general permissions service; for a single-user
   app the existing tiered-permission + audit layer *is* the permissions service. Building
   RBAC with roles/groups/sharing is speculative until there's a second user.

Honourable mention (trim, don't drop): **notifications** and **files** as core services can
start as the thinnest possible thing (an event-bus topic; a path helper) rather than
standalone subsystems.

---

## Tension to name explicitly

The standing instruction is "proceed until there's nothing left / keep pushing until the
app is complete." The v3 brief's Part 14 says "Do not build yet — reply first." Those
conflict for exactly this turn. I'm honouring Part 14: **this document is the deliverable,
and I'm not writing spine/blocks/capability code until you approve the plan** (or tell me
which phase to start). The moment you say go, Phase A (Blocks foundation, starting with
`DataTable`) is the first commit.
