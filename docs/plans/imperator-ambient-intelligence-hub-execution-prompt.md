# Imperator Ambient Intelligence Hub — Authoritative Execution Prompt

Status: owner-approved build instruction.

Audience: Claude Code working in Marco Fernstaedt's `hermes-agent` fork.

This is the single continuation prompt for the Dashboard repository. It combines the Ambient Layer brief, the existing Master Build Prompt decisions, the on-machine Imperator audit, and the corrections needed after reviewing `docs/plans/imperator-ambient-layer-checkpoint.md`.

This prompt authorizes repository implementation. It does **not** authorize editing Marco's installed `~/.hermes/SOUL.md`, memories, personal skills, credentials, services, or schedules. The on-machine Imperator owns those. Do not install the proposed Operating Charter from this repository task.

## Mission

Build an agent with a hub attached, not a hub with a chat box inside it.

The application shell is Imperator's persistent presence. Pages change underneath it; the agent, attention stream, activity state, and access to conversation do not. From every route Marco must be one interaction away from:

1. talking to Imperator;
2. seeing what needs his attention; and
3. seeing what Imperator is doing or what is broken.

Continue until the requested layer is implemented, tested, integrated, committed, and ready for live acceptance. Do not stop after another planning document. If a genuine blocker exists, record its exact source and continue every independent workstream that is not blocked.

## Read first; do not restart from green field

Before changing code, inspect current `main`, repository instructions, tests, and these documents:

- `AGENTS.md`
- `docs/plans/imperator-master-spec-response.md`
- `docs/plans/imperator-master-spec-checkpoint.md`
- `docs/plans/imperator-ambient-layer-checkpoint.md`
- `docs/plans/intelligence-hub-architecture.md`
- `docs/plans/modules-as-manifests.md`
- `docs/dashboard-modules.md`
- `docs/session-lifecycle.md`
- `docs/security/network-egress-isolation.md`

Verify every “already built” claim against current code. Reuse and extend working infrastructure rather than creating parallel stores, transports, review queues, chat sessions, action registries, or permission systems.

The repository already contains substantial foundations: blocks, capability declarations, a review store, a review queue, plugin/module infrastructure, guardrails, health and provenance endpoints, realtime sequence/replay machinery, a volatile `hub_context` tier, and native-chat work behind a flag. Preserve those investments.

## Locked engineering principles

### One authoritative state, many projections

The backend record is canonical. The notification stream is the canonical **human-facing projection**, not a second truth store. Chat, review, shell badges, toasts, and module pages reference the same record ID and subscribe to the same versioned events.

Never create a second approval store, notification store, chat-specific action copy, or module-local resolution state.

### One command contract, but keep the Hermes core narrow

The web interface has no privileged mutation path. A mutating operation is defined once and drives:

- API validation and execution;
- menu, context-menu, and command-palette affordances;
- permission and approval tier;
- idempotency behavior;
- audit and receipt output;
- rollback or compensation declaration; and
- agent accessibility.

Do **not** turn every endpoint into a permanent core model tool. Hermes pays for every core tool schema on every model call. Preserve structural parity through a shared action registry and a small service-gated agent surface, such as bounded `hub_context`, `hub_action`, and `hub_navigate` operations or scoped plugin toolsets generated from the registry. Capability-specific tools should be gated or discoverable at the edge, not permanently inflate the core prompt.

### Byte-stable identity, volatile context through tools

Do not inject route, time, inbox state, queue state, live signals, or link-graph neighborhoods into the stable system prompt. Retrieve a compact, source-backed digest through `hub_context` or the current turn. Preserve provider prompt caching and strict message-role alternation.

### Consequence-based authority

Do not encode “every write requires approval.” That would cripple the agent and contradict the intended operating model.

- Read, inspect, organize, link, classify, draft, stage, test, and reversible in-scope internal writes may execute without repeated approval.
- External sends, submissions, spending, signing, credential changes, public exposure, hard deletion, destructive Git, client-system mutation, structural platform changes, and other irreversible or high-blast-radius actions require exact approval.
- Soft archive and other genuinely reversible internal changes may move up the automation ladder only when their action declaration and owner policy allow it.
- Self-extension is never self-authorization. New capabilities, plugins, MCP servers, network reach, credentials, and permission expansion remain reviewable.

### Accessibility and visual quality are coequal

Build a modern, expensive-feeling desktop application and a fully correct screen-reader/keyboard application at the same time. Do not make it plain because Marco uses NVDA. Fix semantics, focus, ordering, and alternate representations while preserving visual craft.

NVDA on Windows desktop is the primary manual acceptance target. Automated accessibility tests remain mandatory. VoiceOver is a secondary target only where the supported platform can actually be tested. No mobile/iPhone scope is required.

### Current stack over speculative rewrites

Use the current React/Vite/FastAPI/SQLite architecture and existing design system. Add dependencies only for a concrete feature and preserve the bundle budget. Do not perform a wholesale router, state, ORM, or schema-codegen migration merely because an earlier brief named a fashionable stack.

## Phase 0 — repository and protocol reconnaissance

Before implementation:

1. Fetch current `main` and confirm a clean isolated worktree.
2. Map the exact current native-chat transport, `/api/ws`, `/api/events`, sequence/replay behavior, `tui_gateway` method/event catalog, review store, permission gates, approval integrity mode, `hub_context`, action/capability registries, and plugin manifest contract.
3. Inspect commit `a65530a08` and `docs/plans/imperator-ambient-layer-checkpoint.md`; retain correct work but apply the corrections in this prompt.
4. Write or update behavior-contract tests before changing each load-bearing subsystem.
5. If current `AGENTS.md` still says the web Dashboard must never have a native structured React chat while accepted owner documents require it, resolve the contradiction deliberately: land one shared backend session/transport contract, keep the terminal as a separate labeled fallback/debug surface, and update `AGENTS.md` in the same verified change. Do not maintain two competing primary chats.

## Phase 1 — substrate first

Land these foundations before new modules feed them.

### Action registry

Every mutating action declaration includes:

- stable action ID and schema version;
- typed input and typed result;
- actor and source/module;
- permission/risk tier;
- consequence class;
- idempotency policy;
- timeout and retry policy;
- audit/receipt shape;
- execution adapter;
- and one of `inverse`, `compensation`, or `irreversible`.

A build-time test must fail if a mutating action omits rollback semantics. Do not pretend every external mutation has a true inverse:

- `inverse` means a transactionally reliable restoration under our control;
- `compensation` means a best-effort second action whose success must be verified;
- `irreversible` means no safe reversal exists.

Calendar updates, external labels, third-party record changes, and similar operations are generally compensations, not guaranteed undo. Sent messages, purchases, signatures, public posts, and hard deletion are irreversible.

### Idempotency and concurrency

Every mutating request carries an idempotency key scoped to actor, action, target, and payload hash. Persist the outcome so retry after reconnect returns the original result. Use optimistic concurrency/version checks for records and compare-and-set for decisions. Test duplicate submission, reconnect, multi-tab resolution, and stale-client behavior.

### Cost attribution

Add feature/module/action/run attribution at the model dispatch chokepoint before building per-feature budgets. Record provider, model, tier, token/usage data available from the provider, estimated or billed cost, feature/module/action ID, interactive/background origin, and timestamp. Label estimates as estimates.

Do not invent precision providers do not supply.

## Phase 2 — one item record, one aggregate lifecycle

Generalize the existing review record instead of replacing it.

The earlier checkpoint's simple `pending → acknowledged → resolved(approved|...)` model is insufficient because approval is a decision, not proof that execution succeeded.

Use one aggregate record with a validated transition model covering:

- `open`
- `acknowledged`
- `awaiting_decision`
- `modifying`
- `snoozed`
- `denied`
- `expired`
- `approved`
- `queued`
- `executing`
- `succeeded`
- `failed`
- `canceled`
- `compensating`
- `compensated`
- `compensation_failed`

A modified proposal returns to `awaiting_decision` with a new immutable artifact version and payload hash. An approved proposal remains visible as approved/queued/executing until the action finishes and source verification records `succeeded` or `failed`. Never label approval alone as “resolved successfully.”

The record must retain:

- ID, kind, notification class, title, source, rule, risk, and permanence;
- origin turn/session and related entity IDs;
- immutable artifact versions and current payload hash;
- denial reason;
- snooze time or condition;
- decision actor/time;
- execution state, attempt, idempotency key, and verified outcome;
- last transition version and monotonic event sequence;
- why-this-was-surfaced provenance;
- tuning/mute controls for the producing rule.

Notification classes sort in this order:

1. Blocking — Imperator cannot continue without Marco.
2. Actionable — staged work is ready for a decision.
3. Opportunity — suggestion or preparation; never interrupts.
4. Informational — batches into the next brief by default.

Only blocking items may toast, and not while the stream already has focus. Informational and opportunity items never steal focus.

### Projections and duplicate prevention

- Notification stream: full item cards and the primary owner-facing projection.
- Review queue: filtered projection over the same IDs and versions.
- Chat: reference chip/link only, with title and live status; activating it opens/focuses the owning card.
- Shell glance: counts and aggregate status only.
- Toast: ephemeral reference to a blocking item, never another decision card.

Use one client item store fed by one sequenced realtime connection. Enforce “one full card per item per viewport” with a presentation registry and integration tests across routes, portals, virtualization, and the quick-chat overlay. Do not throw a production error merely because a duplicate is detected; suppress the duplicate and report diagnostics.

## Phase 3 — ambient shell

The shell never unmounts during route navigation.

### The glance

Always answer:

- How many items are blocking on Marco?
- What is Imperator doing: idle, thinking, streaming, calling a named tool, delegating, waiting, faulted, or offline?
- Is anything degraded: stale source, failed sync, unreachable device, unhealthy service?

Use a polite live region that announces meaningful transitions once. Tool-loop chatter and token-level updates must not become screen-reader noise.

### Quick chat anywhere

- One configurable keystroke opens it from every route.
- Current route, scroll position, selection, draft text, and focus survive.
- Escape closes and restores exact focus.
- It is route-addressable and participates correctly in browser history.
- It shares the same Hermes session, queue, transcript, command registry, model/reasoning selection, approvals, and turn lifecycle as the full feed.
- A growing overlay promotes to the full feed without cloning messages or creating a parallel session.
- Queue, steer, interrupt, background prompt, tool activity, slash commands, model picker, reasoning effort, MoA presets, and approval references use the same backend methods and events.
- Voice input is progressive enhancement through Hermes voice/STT capability. Always provide keyboard input, a conspicuous recording state, a live transcript, cancel, and failure recovery. Do not block Phase 3 on voice.

One backend session writer owns turn order. Multiple clients observe and submit through the same sequence/idempotency contract.

### Agent navigation

Implement a bounded `hub_navigate` intent, not arbitrary frontend scripting.

The payload names an allow-listed route, entity/record ID, optional view/filter/range, reason, and source turn. The frontend validates the destination and consumes it over the realtime channel.

Before navigation:

- announce the destination;
- detect active typing/composition and request confirmation instead of moving;
- persist the current location in a one-step return token.

After navigation:

- move focus to the route heading or explicitly named record;
- expose “Back to where I was” for one action;
- do not discard drafts or selection.

## Phase 4 — approve, deny, modify, snooze

Build one shared card with full behavior-contract tests.

Fixed content order:

1. What happened — one plain sentence.
2. Context — source artifact with provenance.
3. Work already done — full staged artifact required for judgment.
4. Automated verdict — only the verdict and deterministic evidence actually available.
5. Exact consequence on approval — recipients, destination, writes, external effects, reversibility.
6. Actions — Approve, Modify, Deny, Snooze, plus typed item-specific verbs.

Do not fabricate smart-approval “reasoning.” The current protocol supplies a verdict, not a rationale. Show verdict, gate trigger, tier, scope, redacted arguments, payload hash, and other verified facts. A future structured justification may be added only if explicitly justified by measured value and cost.

Required states:

- idle;
- hovered;
- focused;
- expanded;
- modifying;
- regenerating;
- diff-ready;
- submitting decision;
- approved/queued;
- executing;
- succeeded;
- denied;
- snoozed;
- expired;
- failed with retry;
- stale/decided elsewhere;
- compensating and compensated;
- reduced-motion variants.

Do not reserve the maximum possible artifact height for every card; that creates enormous blank regions. Keep header/actions and minimum footprint stable, use a bounded scrollable artifact region or an anchored expansion layer, and preserve surrounding scroll position through state changes.

Modify stays inside the card. Preserve immutable versions, show a semantic diff, allow stepping back, and rerun approval against the new exact payload hash. Cheap models may handle bounded edits only when a healthy configured auxiliary provider exists; otherwise fall back explicitly.

Deny captures a reason. Quick reasons plus free text are acceptable. Persist the reason as feedback for that category, but do not treat a single denial as universal training data.

Snooze supports a time, condition, or next brief. Wake-up is deterministic and idempotent.

Batch approvals group only identical action types, sources, consequence classes, and approval scopes. Expansion must expose every exact payload before group approval.

## Phase 5 — credential broker and egress boundary

Present one Credentials surface with clear provenance, but keep the stores technically distinct.

### Service credentials

Use the native encrypted service-credential store for API keys, OAuth tokens, and device secrets. The agent receives an opaque handle, not the plaintext value.

The agent should not supply arbitrary host/method/path tuples next to a credential handle. Register connector policies that bind:

- module and action IDs;
- exact hosts and ports;
- allowed methods;
- path templates;
- redirect policy;
- request/response size limits;
- data classes;
- lease duration and use count;
- rate limits;
- and response redaction rules.

At the egress boundary:

1. validate caller, connector, action, lease, and payload;
2. resolve/decrypt only after policy passes;
3. pin and revalidate destination across DNS and redirects to prevent SSRF, DNS rebinding, and credential forwarding;
4. inject the credential as late as possible;
5. strip sensitive headers on every non-approved redirect;
6. scan and redact logs, errors, and returned data;
7. audit handle ID, caller, destination policy, purpose, and outcome—never value;
8. return a bounded response that cannot echo credentials.

“No secret reaches model context” is the acceptance invariant. Test error, redirect, timeout, retry, malicious response, and logging paths.

### Personal password vault

Do not conflate Bitwarden Secrets Manager (`bws`) with Marco's Vaultwarden personal vault. They are different products and protocols. Existing `SecretSource` infrastructure is reusable, but a Vaultwarden personal-vault adapter is not automatically “nearly free.”

Integrate through a vetted Bitwarden-compatible client/CLI or supported API path; do not reimplement zero-knowledge cryptography. Scope access to explicitly selected items or collections, keep unlock/session material out of model context, require user presence where appropriate, and never silently expose the entire personal vault to modules.

### Key-entry experience

For each supported service show:

- purpose;
- direct provider setup documentation;
- set/unset state;
- redacted preview;
- test connection;
- scope and consumers;
- revoke/delete;
- provenance store.

Adding a key must not require editing a file. Behavioral settings belong in `config.yaml`; secrets belong only in the credential stores.

## Phase 6 — universal undo and action journal

Expose a session/time-scoped undo stack and “Undo last agent action.”

- Internal entity create/update/stage/move: real inverse where transactionally controlled.
- Notes and declarations: immutable versions and restore.
- Soft archive/delete: restore until retention expiry.
- Capability application: schema/version rollback with migration safety.
- External calendar, email-label, Home Assistant, or provider mutations: compensation, followed by source verification.
- Sent messages, spend, signature, public post, and expired hard deletion: irreversible.

Approval text must say which category applies. Undo success is not claimed until source verification passes. A failed compensation remains visible and blocking when manual repair is needed.

## Phase 7 — automation ladder, pre-computation, and interruption policy

Each action type has an explicit owner-controlled rung:

1. Manual.
2. Suggested.
3. Drafted and awaiting approval.
4. Executes after exact approval, individually or in a safe batch.
5. Autonomous, then notifies according to policy.

Promotion is always Marco's decision. The system may propose promotion with sample size, accept/modify/deny rates, failures, reversals, and consequence class. Demotion is one action from every appearance.

External sends, hard deletion, spending, signing, public posting, credential changes, and other irreversible actions are permanently capped at rung 4.

Pre-compute reversible work only for enabled categories. Start conservative. Track acceptance, modification, rejection, cost, latency, and staleness. Reduce or stop work for categories with poor value. This tuning is not “free”; budget its deterministic and model costs.

Only blocking items interrupt. Focus mode suppresses every other class into the next brief.

Rehearsal mode simulates deterministic triggers over a chosen horizon. For future content that does not exist yet, show the rule and historical behavior, not invented future actions.

## Phase 8 — cost governance

Feature manifests declare the cheapest valid tier:

1. Deterministic: fetch, query, threshold, sort, schedule, diff, state transition, rule evaluation.
2. Auxiliary model: classification, relevance, triage, short titles, interruption worthiness.
3. Main model: drafting, synthesis, implication, interactive answers.
4. Ensemble/high reasoning: explicit request or genuinely consequential analysis.

A monthly owner-set budget shows live spend/estimate by feature, module, model, day, and interactive/background origin.

- At 80%, noncritical background model work degrades one tier where a declared fallback exists; otherwise it pauses rather than silently changing quality.
- At 100%, background model work pauses. Owner-initiated interactive requests remain available with a clear warning.
- Deterministic health and safety checks continue.

Support an optional OpenAI-compatible auxiliary endpoint on Marco's HP. Health-check it, apply explicit task/model compatibility, and fall back to the configured hosted auxiliary provider. It is optional, never a startup dependency.

Cost-tier defaults for the new feature set:

- Tier 1: weather fetch/alerts, markets watchlist fetch, infrastructure health, Home Assistant state, signal staleness, wardrobe rules, worn/laundry logs, Kanban state/WIP, entity CRUD, snooze/digest timing, ladder statistics, deterministic intention-versus-attention joins, undo journal.
- Tier 2: relevance scoring, interruption gating, classification, short summarization, feature triage, “is this video worth processing,” routine briefing selection/assembly.
- Tier 3: email drafts, interview/deal prep synthesis, news implication, transcript synthesis after triage, contextual trip/activity suggestions, weekly review narrative.
- Tier 4: only explicit ensemble/high-reasoning requests or consequential analysis.

Routing, travel-time, place discovery, and itinerary synthesis are not all Tier 1; distinguish deterministic record assembly from provider-backed discovery and model synthesis.

## Phase 9 — signal source capability

A signal declaration includes:

- stable ID/version and provider/connector;
- poll or subscription mode;
- state schema and units;
- event declarations;
- typed actions and permission tiers;
- strip/tile/status/none treatment;
- numeric history policy;
- health probe;
- staleness threshold;
- setup-state content;
- cost tier;
- credential handle/policy reference.

Generate a tile/status projection, source events, scoped agent reads/actions, and history where declared. Every signal displays last update and a distinct stale/offline state.

### Home Assistant

Use one Home Assistant integration over Tailscale. Do not write direct Bambu or ESPHome device integrations into the hub.

Ship three states:

1. Connected — health, last sync, discovered entities.
2. Disconnected — failure reason and reconnect.
3. Not set up — what HA provides, why it is needed, prerequisites, environment-verified Raspberry Pi 5 installation guidance, Tailscale-only connection, and a connect/test/discovery flow.

Bambu P1P fields must be generated from discovered Home Assistant entities and the installed integration's real capabilities. Do not hardcode AMS fields when no AMS entity exists. Printer pause/resume/cancel actions require the declared consequence/approval policy and live source verification.

Launch signals:

- weather: current, forecast, alerts;
- markets: owner watchlist using a legal free-tier source; private companies such as SpaceX show news/status rather than a fake price;
- infrastructure: VPS, Pi, HP/Tailscale reachability, resource/service health, and the app itself.

No public port forwarding.

## Phase 10 — capabilities and modules

Use capability declarations for data-shaped working areas and coded modules/plugins for bespoke interaction or external I/O. Do not force email readers, calendar grids, media players, map interactions, or Jobs application workflows through a generic CRUD renderer.

### News

- Configurable beats: AI/technology, home health, and local news.
- Sources through feeds plus existing Hermes search/extract/browse capabilities when configured.
- Separate factual summary, labeled source analysis, and labeled Imperator implication.
- Visible source, author, date, retrieval time, and disagreement.
- Contested/political stories show credible framing across perspectives without editorially collapsing them.
- Developing stories update one record instead of re-notifying.
- At most three items per day may be promoted to the notification stream by default; the rest remain in feed/digest.
- Feed-tuning questions are opportunity items, never interruptions.

### Briefings

- Scheduled and on demand.
- Text is canonical, scannable, linked, and always available.
- Spoken narration is optional by owner preference or explicit request, generated for speech rather than reading markup verbatim.
- Inputs are deterministic and source-backed; selection/assembly may use Tier 2.
- Delivery uses the obligation ledger and reports failed delivery. No silent loss.

### Wardrobe

- Entity fields: type, warmth, formality, color, fabric, last worn, laundry, condition, notes.
- Conversational population through the same API as the form.
- Deterministic recommendations from weather, calendar formality, recency, laundry, and learned weights.
- Accepted/rejected suggestion log.
- Model use only for explanation or novelty on request.

### Reading and knowledge

- Books/long-form entities with status, progress, source, reason, goals/projects.
- Curated highlights and notes may write real human-readable Obsidian notes through the vault service.
- Never dump agent execution logs, raw proof, or memory mirrors into Obsidian.
- Resurface notes by link graph and upcoming context, not random quotes.

### Entertainment

- YouTube uses compliant embedding for playback.
- Add subscription/watch-later triage, transcripts where legally/technically available, worth-my-time assessment, summaries, and curated notes.
- Spotify remains Connect-oriented.
- Do not build thin wrappers that add no triage or context value.

### Places, activities, and trips

- Durable place and trip entities.
- Context-aware discovery from time gap, area, preferences, cost, accessibility, and weather.
- Itinerary with travel segments, bookings, packing, research, and a first-class linear agenda equivalent to any map.
- Calendar writes go through the calendar service/action registry, never directly to Google.

### Ideas and builds

- Source, effort, value, status, linked inspiration/goals.
- Inputs from news, observed repeated friction, and stated goals.
- Start action proposes or creates a Kanban board through the registered action according to its permission tier.

### Kanban

- Columns, cards, WIP, keyboard and pointer movement, profile assignment, multiple boards, live agent state.
- Full-action linear list parity.
- Recommend durable board creation for multi-step work rather than lecturing or auto-creating without policy.

## Phase 11 — intention, attention, focus, and setup

### Weekly review

Quantitatively compare stated goals/commitments with calendar, sessions, pipeline movement, and progress logs. Distinguish genuine reprioritization from drift. Prepare the review ahead of the ritual. Deliver one evidence-backed recommended change, not ambient nagging.

This is opt-in, local, exportable, and wipeable.

### Situational modes

- Focus: only blocking interrupts.
- Morning: briefing-forward.
- Confirmed deep work: suggest focus.
- Evening: tomorrow preparation.

Modes are suggested/confirmable and always overridable. Never silently impose a behavioral mode from an inference.

### Guided setup

Every integration has Connected, Disconnected, and Not-yet-set-up surfaces. No blank page, dead tile, or generic stack trace. Setup instructions must be generated or selected from live environment facts; do not hardcode commands for an environment not inspected.

## Visual and accessibility acceptance

- Persistent obsidian depth, structural gradients, warm rim light, gold as the single importance accent.
- Motion is caused, not decorative; use transforms/opacity where possible and preserve bundle budget.
- `prefers-reduced-motion` and the in-app setting make every transition immediate without losing state information.
- Correct names, roles, headings, landmark order, focus return, keyboard parity, errors, and live-region restraint.
- Linear equivalents for boards, calendars, maps, graphs, and other visual-first views.
- Route changes and realtime updates never steal focus.
- No item or notification is announced multiple times from parallel surfaces.
- Test at 200% and 400% text scaling without clipping or loss of operation.

## Agent interaction contract the UI must support

The future Operating Charter is directionally right, but the platform must support this corrected contract:

- Imperator may autonomously perform ordinary internal, reversible, in-scope work. Approval is consequence-based, not “all writes.”
- Durable work uses Hermes todo/run-control/Kanban/session state; do not invent an undefined scratchpad store.
- Delegation is parallel but not durable across parent-session termination. Cron/Kanban/run-control are the durable mechanisms.
- Source-specific data stays in its authoritative module. Hermes memory stores compact stable facts; Obsidian stores curated human reference—not execution dumps.
- The agent acts only in connected modules and granted scopes, not “every module” by assumption.
- The agent may improve existing skills and local procedures in scope; new network reach, credentials, plugins, MCP servers, or authority require review.
- Local commits and verified private-repo pushes may be allowed within an owner-approved coding mission; “never commit” is not a general rule. External sends/submissions remain gated.
- Broker-only secret handling is an acceptance target once the broker is active. Before that, existing secret boundaries must remain fail-closed and no raw secret may enter model context.
- Agent-visible progress shows goals, decisions, tool/action names, direct evidence, blockers, and receipts—not hidden chain-of-thought.
- Meaningful self-improvement is visible and correctable, but routine introspection must not become another notification stream.

Do not install or duplicate this charter in repository code. Build the interfaces and contracts it depends on. Marco and the on-machine Imperator will finalize the concise SOUL after the platform surfaces exist.

## Build order

Use this sequence and keep `main` green after each independently useful phase:

1. Recon and behavior-contract tests.
2. Action registry, idempotency, rollback semantics, cost attribution.
3. Aggregate item lifecycle and one-store projections.
4. Ambient shell and shared-session quick chat.
5. Approve/deny/modify/snooze with execution outcomes.
6. Credential broker and egress safety.
7. Undo/compensation journal.
8. Automation ladder, pre-computation, focus, rehearsal.
9. Cost budget and optional auxiliary provider.
10. Signal declarations and guided setup.
11. Wardrobe as the first deterministic proof capability.
12. News and briefings.
13. Reading, places/trips, ideas/builds, Kanban expansion, entertainment triage.
14. Intention-versus-attention and weekly review.
15. Final visual/accessibility/performance hardening and live acceptance package.

Parallelize only independent read/review/test work. Never assign concurrent writers to the same mutable artifact, store, migration, branch, or worktree.

## Definition of done for every phase

A phase is not complete because code exists.

Required proof:

- exact changed files and architectural contract;
- focused unit and integration tests;
- real persistence/restart behavior where stateful;
- multi-tab/reconnect/idempotency tests where realtime or mutating;
- accessibility test plus manual keyboard/NVDA acceptance instructions;
- security-negative tests for approval, credentials, egress, and scopes;
- frontend typecheck, lint, tests, production build, and bundle budget;
- relevant backend tests, including a temporary `HERMES_HOME` for config/state/security paths;
- database migration forward and rollback/compatibility proof;
- no secret values in source, fixtures, logs, build output, or screenshots;
- source and packaged-frontend provenance aligned for deployment;
- updated architecture/operator docs where a contract changed;
- a clean commit and pushed branch or owner-approved `main` update.

For the final release, rebuild `hermes_cli/web_dist`, deploy through the one authoritative Dashboard tree, verify the live authenticated route and asset provenance, verify service health and restart count, and perform an NVDA acceptance pass. Do not claim live completion from local tests alone.

## Immediate instruction

The checkpoint has already been written. Do not answer with another checkpoint.

Start at Phase 0, reconcile the current branch against this prompt, then implement Phase 1. Continue phase by phase, committing verified increments. When a genuine decision is unavoidable, make the safest reversible default and document it; ask only when the choice changes external consequence, security authority, or product direction.
