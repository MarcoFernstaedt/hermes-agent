# Imperator — Ambient Layer checkpoint

Response to Part 16 of *The Ambient Layer*, verified against the installed
repository rather than assumed. Answers are in the brief's order.

---

## 1. Blockers

Only three things in Parts 1–15 are wrong or impossible as written. Everything
else is feasible; several are further along than the brief assumes.

### 1a. Smart approvals carry a verdict but **no reasoning** — Part 3 is not buildable as specified

Part 3 asks the card to show "the reviewer's judgement **and reasoning**".
`tools/approval.py::_smart_approve` asks the guard model for *exactly one word*
— `APPROVE`, `DENY`, or `ESCALATE` — at `max_tokens=16`, and reduces the reply
to that string. No rationale is generated, so none can be displayed. This was
confirmed independently by the on-machine agent in round-2 recon, which
recommended showing verified facts only.

There is no honest way to render reasoning that does not exist. Three options,
with a recommendation:

- **Show the verdict alone, plus the facts we do hold** (recommended, already
  shipped). The card now names the *trigger* — `payload.description`, the
  pattern that actually tripped the gate — which the UI had been discarding
  entirely. Combined with the tool, redacted arguments, tier, scope and
  permanence, that is a genuinely informative card containing zero invention.
- **Change the protocol** to request a short structured justification. Costs
  tokens and latency on *every* gated call, and still yields a model's
  explanation rather than evidence the action is safe.
- **Reconstruct a rationale locally** from tier and guardrail signals. Rejected:
  it would read as authoritative while being synthetic.

Standing recommendation: option 1, with option 2 available if you want it and
accept the per-call cost. **This one needs your decision.**

### 1b. "Cost visible per feature, per module, per day" needs a cost ledger that does not exist

Part 9 assumes per-feature attribution. Today spend is observable per model
call, not per originating feature, because nothing tags a call with the feature
that caused it. This is buildable — the dispatch chokepoint is the natural
tagging point — but it is a *prerequisite* of the budget system, not a readout
of it. Sequenced accordingly in §8; not a blocker, a dependency the brief did
not name.

### 1c. Rehearsal mode (Part 13) is bounded by what is simulable

"Show me what you *would* do over the next week" is feasible for anything whose
trigger is deterministic — scheduled briefings, threshold alerts, staleness
checks, wardrobe rules, digest batching. It is **not** simulable for anything
whose trigger is a model judgement about content that has not arrived yet: you
cannot know which of next week's emails would have been drafted, because next
week's emails do not exist.

Not a blocker, a scope correction. Rehearsal will show: every deterministic
action it would take, plus, for model-gated categories, the *rules* that would
fire and the historical accept rate for that category. Labelled as such.

### Not blockers, worth stating

- **Vaultwarden is nearly free.** `agent/secret_sources/` already defines a
  `SecretSource` ABC with a registry, and already ships `bitwarden.py` (Bitwarden
  Secrets Manager via the `bws` CLI, pinned version, SHA-256 verified, failures
  never block startup). Your Part 6 split is not just right, it is mostly
  built — Vaultwarden is a *backend registration*, not a project.
- **Home Assistant not being installed is fine** and is exactly what Part 14
  exists for. No blocker.
- **YouTube:** your constraint is correct — the API terms require the embedded
  player; a custom player is not permitted. The transcript/summarize/triage
  layer needs no player permission and is where the value is.
- **Local model tier** is configuration: the provider layer already speaks
  OpenAI-compatible endpoints, so an HP-hosted small model is a base-URL entry.

---

## 2. The item state machine — one record, many views, no duplicates

### The store

`hermes_cli/review/store.py` already holds the right shape: a single SQLite
table with `id, kind, title, summary, source, risk, status, payload, preview,
created_at`, a status index, and compare-and-set updates (`UPDATE … WHERE id = ?
AND status = ?`) that make concurrent resolution safe.

It generalises into the item stream rather than being replaced. Three additions:

| Column | Why |
|---|---|
| `klass` | `blocking \| actionable \| opportunity \| informational` — the Part 2 taxonomy, which drives sort order and interrupt policy |
| `snoozed_until`, `snooze_condition` | Snooze as a first-class verb (Part 2) |
| `origin_turn_id` | Which chat turn produced it, so chat can *reference* without copying |
| `rule_id` | Which rule fired, so "why am I seeing this" can name and tune its source |
| `reason` | Denial reason, so `/deny <reason>` is training data rather than noise |

Lifecycle: `pending → acknowledged → resolved(approved | denied | modified |
expired | snoozed)`. Snooze re-enters `pending` when its time or condition
elapses; the transition is recorded, not overwritten, so the trust dashboard
(Part 8) can compute real accept rates.

### One canonical list, three projections

- **Notification stream** — `SELECT * ORDER BY klass, created_at`. Canonical.
- **Review queue** — the *same table* filtered to actionable and blocking. It is
  a `WHERE` clause, not a second store. It already is one today.
- **Chat** — renders a **reference chip**, never the card. The chip carries the
  item id, its title and its current status, and activating it focuses the item
  in the stream. This is the whole answer to "how does chat reference without
  duplicating": chat holds an *id*, and the card has exactly one render site.
- **Toast** — blocking only, and suppressed when the stream is already the
  focused surface.

### Resolution propagation

One writer, one broadcast. Resolution goes through the store's compare-and-set
update; on success the server emits an `item.resolved` frame carrying `{id,
status, version}` on the existing realtime channel. Every surface holding that
id reduces the same frame. Because the update is CAS, a double-resolve from two
tabs makes the second a no-op that reports the winning status rather than
silently clobbering it.

The screen-reader consequence is the reason for the strictness: one item, one
live-region announcement, from the one surface that owns the card.

### The invariant, enforced not intended

A `useItem(id)` hook is the only way to render an item card, and it registers
the id in a render-scope set. A second registration of the same id in the same
viewport throws in development and logs in production. "Never render the same
item twice" is otherwise a rule that decays the moment someone adds a surface.

---

## 3. The approve / deny / modify card, state by state

One footprint across every state — the card reserves its maximum height so no
transition reflows the list beneath it. Every transition has a reduced-motion
variant that changes state without movement.

| State | Visual | Semantics | Motion |
|---|---|---|---|
| **idle** | Card at rest, structural gradient, no rim light | `article`, labelled by its title; actions in DOM order Approve, Modify, Deny, Snooze | none |
| **hovered** | Warm rim light rises on the top edge | no change | 160ms state band |
| **focused** | Gold focus ring on the focused control only, never the card | roving focus within the card; Escape returns to the list | 100ms micro |
| **expanded** | Context and staged work reveal at full height | `aria-expanded` on the disclosure; content in the same DOM order as visually | 280ms panel |
| **modifying** | Input appears *inside* the card; artifact stays visible above it | input labelled "Describe the change"; the artifact keeps its heading so context is never lost | 240ms move |
| **regenerating** | Artifact dims to 60%, shimmer along its leading edge, previous version still readable | `aria-busy` on the artifact region; polite "Regenerating" announcement, once | shimmer, reduced-motion → static dim |
| **diff-ready** | New artifact in place, changed spans marked with gold underlay, version stepper appears | changes announced as a count ("3 changes"), each navigable; not a raw diff dump | 240ms move |
| **submitting** | Actions disabled, the invoked action shows a spinner in place | `aria-disabled`, not removal — the buttons must not vanish under a screen reader mid-read | 100ms micro |
| **approved** | Gold settles, then collapses to a one-line resolved summary | polite "Approved", then the row leaves the actionable list | 240ms settle → 280ms collapse |
| **denied** | Same collapse, neutral tone, reason retained on the summary line | polite "Denied", reason read | as above |
| **snoozed** | Collapses with the wake time stated on the summary line | "Snoozed until Thursday 9am" | as above |
| **expired** | Muted, actions replaced by a single "Expired" note and a dismiss | announced only when the list is next focused, never as an interrupt | none |
| **error-with-retry** | Destructive-toned border, error text, Retry as primary | `role="alert"`, retry focused | 160ms state |

Fixed content order, top to bottom: **what happened** (one plain sentence) →
**context** (source artifact, expandable) → **staged work** (full text, never
truncated behind a click when it must be judged) → **verdict** (the smart-approval
result where one exists — see §1a; the trigger is always shown) → **what happens
on approve** (recipients, destinations, irreversibility called out explicitly) →
**actions**.

Modify runs on the cheap tier unless the requested change is substantive; the
classifier deciding that is itself a tier-2 call.

---

## 4. The credential broker

### Confirmation, plainly

**The agent never holds a secret.** It holds an opaque handle. Resolution happens
inside the process, at the network boundary, after the agent's last opportunity
to observe anything.

### The egress proxy

```
agent → egress.request(credential="gmail", host, method, path, body)
          ↓  handle, never a value
      broker: resolve handle → scope check → lease check → inject → send
          ↓
      response (secret-scanned) → agent
```

Nothing in the returned response, the tool result, the audit row, or any log
line contains the credential value. The audit row records *which* handle, which
caller, which endpoint, why, and the outcome — counts and identifiers, never
values. That rule already holds in `agent_guards`, which carries counts and
never recipient values, and it extends unchanged.

### Scoping

A credential binds to an allow-list of `(module, host, method, path-prefix)`.
A Gmail token that can only reach `gmail.googleapis.com` cannot be aimed at an
arbitrary domain even if the agent is prompt-injected into trying. Scope is
checked **before** resolution, so a mis-scoped call never causes a decrypt.

### Leases

A lease is `(handle, grantee, expires_at, max_uses)`. Time-boxed, revocable
instantly from the Credentials surface, and auto-expiring. Revocation is
immediate rather than eventual: the check is a read of live state on every call,
not a cached grant.

### Native vault vs Vaultwarden — recommendation

**Your split is right, and half of it already exists.** Keep them separate:

- **Service credentials** → native, in-app, broker-mediated. These need
  scoping, leases and machine use, which a password manager does not model.
- **Personal passwords** → Vaultwarden, through `SecretSource`. The ABC, the
  registry and a working Bitwarden Secrets Manager backend are already in-tree
  (`agent/secret_sources/`). Vaultwarden is a *registered backend*, not a build.

Reimplementing Bitwarden's zero-knowledge protocol would be a security project
whose subtle failure mode is worse than not doing it. Agreed and not attempted.

One Credentials surface, two stores, provenance shown per secret.

### One chokepoint, three wins

Secret scanning, rate ceilings and anomaly detection already exist at the
dispatch chokepoint (`agent_guards`). The egress proxy is the *network* twin of
that seam, and the same three live there rather than being rebuilt per module.

---

## 5. Tier declarations

Every feature in Parts 10–11, with its tier. The brief's own test: if more than
a third claim tier 3, the design is wrong.

| Feature | Tier | Note |
|---|---|---|
| Weather signal | 1 | fetch + thresholds |
| Markets watchlist | 1 | fetch + deltas |
| Infrastructure health | 1 | reachability, resource reads |
| Home Assistant / Bambu P1P | 1 | subscription, state shape |
| Signal staleness detection | 1 | timestamp comparison |
| Wardrobe suggestion | 1 | **deterministic rule** — weather + formality + recency + laundry |
| Wardrobe worn-log, laundry state | 1 | records |
| Kanban board, WIP limits, movement | 1 | state machine |
| Places, trips, itinerary assembly | 1 | records + calendar reads |
| Packing list generation | 1 | wardrobe ∩ destination weather |
| Reading progress, highlights capture | 1 | records + vault writes |
| Spaced resurfacing selection | 1 | link graph + calendar proximity |
| Undo / inverse operations | 1 | recorded inverses |
| Digest batching, snooze wake | 1 | scheduling |
| Automation ladder stats | 1 | counting |
| Intention-vs-attention gap | 1 | joins over own data |
| News relevance scoring | 2 | high volume, low stakes |
| Is-this-worth-interrupting | 2 | the interrupt gate |
| Item titling, summarisation | 2 | |
| Modify-change classification | 2 | substantive or not |
| Video worth-my-time judgement | 2 | before any transcript spend |
| Briefing assembly | 2 | daily, must be cheap |
| News implication layer | 3 | only for items clearing relevance |
| Email/message draft generation | 3 | |
| Interview prep pack synthesis | 3 | |
| Video transcript summarisation | 3 | after the tier-2 gate |
| Reading → project connection | 3 | on request |
| Wardrobe "why", novel occasion | 3 | **only when asked** |
| Weekly review preparation | 3 | once weekly |
| Rehearsal mode projection | 3 | on demand |
| Multi-perspective political framing | 3 | contested stories only |
| Consequential analysis on request | 4 | only when you ask |

**17 of 32 are tier 1. Six are tier 2. Eight are tier 3, of which five are
on-request or once-weekly. One is tier 4.** Tier 3 is 25%, under the third you
set, and the highest-volume paths — relevance, interrupt gating, titling — are
all tier 2 or below.

---

## 6. Signal source declaration, with Home Assistant / Bambu P1P

Same principle as capability declarations: **data, validated against a published
schema, rendered by a fixed renderer.** No per-signal UI code.

```json
{
  "id": "bambu-p1p",
  "label": "Bambu P1P",
  "via": { "kind": "home_assistant", "entity_prefix": "sensor.p1p_" },
  "transport": { "mode": "subscribe", "staleness_seconds": 90 },
  "state": {
    "print_progress": { "type": "percent", "label": "Progress" },
    "time_remaining": { "type": "duration", "label": "Remaining" },
    "nozzle_temp":    { "type": "temperature", "label": "Nozzle" },
    "bed_temp":       { "type": "temperature", "label": "Bed" },
    "ams_humidity":   { "type": "percent", "label": "AMS humidity" },
    "status":         { "type": "enum", "values": ["idle","printing","paused","failed"] }
  },
  "emits": [
    { "event": "print.complete", "when": "status transitions to idle from printing" },
    { "event": "print.failed",   "when": "status becomes failed", "klass": "blocking" }
  ],
  "actions": [
    { "id": "pause",  "label": "Pause print",  "tier": "APPROVAL" },
    { "id": "resume", "label": "Resume print", "tier": "APPROVAL" }
  ],
  "render": { "treatment": "tile", "primary": "print_progress", "secondary": "time_remaining" },
  "history": ["nozzle_temp", "bed_temp"]
}
```

From that declaration, with no bespoke code: a live tile, a shell status entry,
event-bus emissions, agent tools to read state and invoke actions (at the
declared permission tier), and a history series for the numeric fields.

`staleness_seconds: 90` is load-bearing. Past it the tile switches to its stale
treatment and states its last-updated time. **A stale progress bar rendered as
live is worse than showing nothing** — so staleness is a declared property, not
a per-tile decision someone might forget.

### The not-yet-configured state

Home Assistant is not installed, so the module's *first* shipped state is the
Part 14 third state, fully designed:

- **What this is** — one paragraph on Home Assistant and why the hub uses it as
  the single device integration rather than writing per-device code.
- **What you get** — named: the P1P over LAN mode (progress, time remaining,
  temperatures, AMS, failures), ESPHome blinds when built, and everything future
  for free.
- **Exact steps for a Raspberry Pi 5**, copy-pasteable, with the Tailscale
  guidance stated as the connection path — nothing exposed publicly, no port
  forwarding.
- **Connect flow** at the end: base URL, long-lived token, test connection,
  entity discovery.

The tile shows the setup card, not an error and not a blank. Same treatment for
every provider, key and device.

---

## 7. Undo coverage

Recorded as **inverse operations**, not log entries. The journal stores
`(action_id, actor, inverse_op, payload, recorded_at, reversible)`.

**Reversible — inverse recorded:**

| Action | Inverse |
|---|---|
| Archive email | unarchive to prior label set |
| Change lifecycle stage | restore prior stage + prior `updated_at` |
| Write/edit note | restore prior version |
| Create record | soft delete |
| Soft delete | restore |
| Apply capability declaration | roll back to prior declaration |
| Move Kanban card | restore prior column and position |
| Snooze / resolve an item | restore prior status |
| Add credential scope or lease | revoke |
| Promote an automation rung | demote |
| Wardrobe worn-log entry | remove entry |
| Calendar event create/update | delete / restore prior |

**Genuinely irreversible — stated at approval time, marked permanently in the
journal:**

sent email or message · spend or charge · signature · external API calls with
side effects outside our control (third-party posts, orders) · hard delete after
retention expiry · anything the automation ladder therefore caps at rung 4.

### Keeping the journal correct as capabilities are added

This is the part that rots if left to discipline, so it is structural:

1. **The action registry is the single registration point.** One registration
   produces the menu item, context-menu entry, palette entry, API endpoint and
   agent tool — and it carries a required `inverse` field.
2. **`inverse` is not optional.** It is either an inverse operation or the
   explicit literal `IRREVERSIBLE` with a stated reason. There is no third
   value, so "forgot to think about it" cannot typecheck.
3. **A test walks the registry** and fails if any mutating action lacks one of
   those two. A new capability that forgets its inverse breaks the build rather
   than silently shipping an un-undoable action.
4. **Generated CRUD inherits inverses automatically** — capability declarations
   produce create/update/advance actions whose inverses are derivable, so the
   common case needs no author thought at all.

Build early. Retrofitting inverses across an existing action surface is the
painful path, and the brief is right that cheap mistakes are what make fast
approval psychologically possible.

---

## 8. Phase plan

Sequenced so the shell and the state machine land before the capabilities that
feed them — feeding a stream that does not exist yet is how duplicates get born.

| Phase | Contents | Why here |
|---|---|---|
| **A. Substrate** | Action registry (with mandatory `inverse`) · undo journal · idempotency keys on mutating actions · cost tagging at the dispatch chokepoint | Everything downstream registers into these. Retrofitting any of the four is the expensive path. |
| **B. Item state machine** | Generalise `ReviewStore` → item stream (klass, snooze, origin_turn, rule_id, reason) · CAS resolution + `item.resolved` broadcast · `useItem` duplicate guard · taxonomy sort · digest batching · why-am-I-seeing-this · snooze | The single most important rule in the brief. Must precede any new producer. |
| **C. Ambient shell** | The glance (three states, live region) · quick chat overlay sharing the main session · route-addressable, focus-restoring · agent navigation tool + back-to-where-I-was | The chrome is the agent. Lands before capabilities so they inherit it. |
| **D. Approve/deny/modify card** | Full state table from §3 · conversational modify with in-card diff + version history · `/deny <reason>` · batch approvals | The most-used component; every later capability renders through it. |
| **E. Credential broker** | Egress proxy · scoping · leases · audit · Vaultwarden via `SecretSource` · API-key entry surface | Gates the signal sources and any capability that talks to a third party. |
| **F. Signal sources** | Declaration schema + fixed renderer · staleness · not-yet-configured state · Home Assistant (+ Bambu P1P) · weather · markets · infrastructure | Needs E for credentials, B for its events. |
| **G. Pre-computation + ladder** | Reversible-work staging · per-category accept-rate budget · the five rungs · rung-4 cap on irreversible · trust dashboard | Needs B, D and the undo journal to be safe. |
| **H. Capabilities** | Wardrobe · reading/knowledge · news · briefings · Kanban recommendation · places/trips · ideas/builds · entertainment triage | Mostly declarations by this point. Wardrobe first: it is the proof that the app is not mostly AI. |
| **I. Reflection** | Intention-vs-attention · weekly review ritual · focus and situational modes · rehearsal mode (bounded per §1c) | Needs the history the earlier phases generate. Meaningless without it. |

Phase A is where I start.

---

## Open decision for you

**§1a only.** Whether the approval card should keep showing verdict-plus-facts
(shipped, honest, zero cost), or whether the protocol changes to request a short
justification on every gated call (costs tokens and latency, yields explanation
rather than evidence). I recommend keeping what shipped. Everything else in this
document is decided and I am building it.
