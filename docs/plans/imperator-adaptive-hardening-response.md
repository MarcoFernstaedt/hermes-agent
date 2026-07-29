# Imperator Adaptive Intelligence & Hardening — Response (plan, no build)

Answering Part 5. Grounded in what exists: permission tiers
(`hermes_cli.module_permissions`), audit log, the entity store + link graph +
`/api/capabilities`, the `/api/events` bus, capability modules, and the agent
tools now covering Jobs/Progress/Vault/Calendar/Memory/Delegation.

## 1. Build order — I agree, with one addition

Yes: **safety rails before proactivity.** Proactivity without a hard brake and
server-enforced scopes is a liability. Sequence:

1. **Session capability scopes** (server-enforced: a scoped-out tool is *refused*,
   not hidden) + **global stop** (halts in-flight work *and* schedulers, not a UI
   toggle). These two first — they bound everything after.
2. **Approval integrity** — hash what's approved, verify it hasn't changed at
   execution. Cheap, essential, do it before any automation can act.
3. **Rate-limit + anomaly + outbound secret-scan** — per-category write/send/
   delete ceilings; first-contact / first-vault-path / burst-delete flags; scan
   every outbound payload for credentials before it leaves. Defense in depth
   under the audit log.
4. **Daily briefing + review-queue suggestions** (read-only proactivity).
5. **Automation rules** (the same engine as suggestions — §3).
6. **Usage adaptation** (§2) — last, and shippable **off by default**.

Rationale: 1–3 are the guardrails; 4–5 are proactivity that leans on them; 6 is
the highest-risk-to-feel-right, so it goes last and opt-in.

## 2. The usage-adaptation engine (highest-risk to get right)

**What it observes** — locally only: which surfaces you open, which suggestions/
actions you confirm vs dismiss, palette picks, searches, and the time-of-day +
active profile context around each. Nothing more.

**Where it lives** — a local `usage_events` table in the entity store (same DB,
same backup/export/**wipe** as everything else). It is **never sent anywhere** —
no telemetry is already a hard rule, and this obeys it. It's yours to clear.

**The model is rules, not a black box** — decay-weighted frequency+recency
scores per (surface, context). Explainable *by construction*: "at the top
because you opened it 14× this week, mostly in the morning." No opaque ML.

**What adaptation may and may not do:**
- **Priority only, automatic + reversible**: reorder nav (frequent rises, dormant
  recedes — never removed), weight search/palette toward what you reach for,
  draw suggested-next-actions from what you usually do on a surface.
- **Availability never changes** — nothing is hidden or removed by adaptation,
  only reordered. The full set is always visible and pinnable.
- **Structure is never automatic** — a new tracker/dashboard is always a
  *proposal* (§4), never a silent restructure.

**Making it an ally, not surveillance** (the honest bit): local-only + legible +
correctable + wipeable is necessary but not sufficient. The behaviors that
decide whether it feels creepy:
- **Hysteresis.** Adapt *slowly*. Require sustained change before moving
  anything — never reorder on a single unusual session. An interface that
  twitches every day is worse than a static one.
- **Pinning always wins.** If you placed it, it never moves. Full stop.
- **Every move is explainable and one-click revertible** — a "why is this here"
  inspector, and "put it back."
- **Master switch + per-behavior switches.** Freeze means *frozen*, completely.
- **Ship it OFF.** Let you turn it on after seeing the "here's what it learned"
  surface, so the first experience is transparency, not the app moving under you.

## 3. One model for proactivity *and* automation

Do **not** build two systems. Build one **rule engine over the event bus**:

```
rule = { trigger: <event pattern>, conditions: [...], steps: [...] }
```

- A **proactive suggestion** is a rule whose action is *propose to the review
  queue* — it never executes, only surfaces a gated proposal.
- An **automation** is a rule whose steps *execute* — still through the
  permission model.
- Same authoring UI, same **dry-run against past events** before enabling, same
  audit trail, same self-disable-on-repeated-error.
- **Promotion is a mode flip**: a suggestion class you always accept can be
  promoted to an automation by changing its action from propose→execute (you
  approve the promotion; never silent). One model, two execution modes — you
  maintain one thing, not two overlapping "app does something when X" systems.

The **review queue is an inbox**: suggestions accrete, nothing interrupts, you
clear it on your terms. A class you keep rejecting goes quiet **and tells you it
has** (legible silence, not a black hole).

## 4. Permission & safety for automations + agent-proposed structure

The invariant: **nothing here lets the agent act unattended beyond what you have
explicitly trusted.**

- **Every automation step is a tool call through the existing tier system.** An
  automation cannot do unattended what the agent couldn't do with approval —
  *unless* you've trusted that exact step (trust is **per-step, per-rule,
  revocable**). Destructive tiers (send/delete/overwrite) are **never
  auto-trustable** — they stay fail-safe ALWAYS_APPROVAL, the line already held
  for vault/email.
- **Scopes bound automations too**: a rule running in a read-only scope can't
  write, enforced server-side.
- **Rate-limit + anomaly + outbound secret-scan apply to automation-driven
  actions** — the burst/first-contact/secret checks don't care whether a human
  or a rule triggered the action.
- **Agent-proposed structural change** (a new capability, a dashboard) is a
  **proposal in the same review queue**. Approving it runs the Module SDK
  scaffold — which creates a *capability declaration* (data), not a privileged
  action. The agent never restructures unasked; priority adaptation is
  automatic+reversible, structural adaptation is always proposed+approved.
- **Every rule run is audited**; a rule that errors repeatedly disables itself
  and says so.

## 5. What's over-engineered / unsafe / would make the app worse

Honest calls:

- **Adaptive surfaces are NOT a mistake — *if* constrained** to priority-only +
  hysteresis + pin-wins + legible + freeze + off-by-default. Unconstrained, they
  are exactly the "interface moves under me" failure you named. The constraints
  in §2 are the whole game; without them, cut the feature.
- **Point-in-time recovery: over-engineered for v1.** Full PITR of the entity
  store is heavy. Periodic snapshots + the audit log's reversible ops (undo)
  cover the real need ("I broke something, roll back"). Ship snapshots + undo;
  defer true PITR until you actually want minute-granular rollback.
- **Anomaly detection: start with rules, not ML.** Rate ceilings + first-contact
  / first-path / burst flags catch the real "wrong thing happening now" cases. An
  ML anomaly model is premature and hard to make legible.
- **Do early, don't skimp: approval-integrity hashing and the server-enforced
  global stop.** Both cheap, both load-bearing for everything proactive.
- **Worth it: offsite encrypted backup (client-side key) + automated
  test-restore on a cadence** with the last-verified-restore date on the
  durability surface. An untested backup is a guess.
- **The real risk to living in the app is nagging**, not moving. Mitigate with
  the inbox model (nothing interrupts), rejection-aware suggestions that go quiet,
  and reflection reports that are quiet artifacts you can ignore — never a prompt
  that demands attention.

## Recommended first increment (when you greenlight building)

**Session capability scopes + the global stop**, server-enforced, with the
active scope always visible in chat. Everything adaptive and proactive is safer
to build once those two exist. This is verifiable here (no model needed): scope
enforcement and the stop are testable at the permission/registry layer.
