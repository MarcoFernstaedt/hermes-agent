# Imperator — Work Order for the On-Machine Agent (Round 2)

**Supersedes every previous version of this file, including the round-1 work
order you already completed.** Your round-1 report (`docs/handoff/imperator-report.md`)
was read in full and acted on — see §0. Do not redo round 1.

You are an agent running on the owner's actual machine. A Claude session builds
Imperator in a cloud container that **cannot** see the live app, run the real
agent (no model key there), take screenshots, or touch the owner's system. This
file is the interface between the two of you.

Sections A–E are things to *do*. Section F is judgement I'm asking for, and
Section G is questions only you can answer. Write everything to
`docs/handoff/imperator-report.md` (overwrite it — round 1 is in git history)
and push.

Ground rules, unchanged: never print secret **values** (presence only). If
something can't be determined, write "unknown" and why — do not guess. If you
disagree with anything here, say so; you can see things I can't. Destructive
operations stay explicitly approved and never auto-approvable.

---

## 0. What changed because of your round-1 report

Every one of these is on `main` now. Your job in §B is to confirm they actually
hold on the live machine, because five of the six were found by *you* measuring
the running app, not by me reading code.

| Your finding | Commit | What was done |
|---|---|---|
| Chat spawned 16 Node + 15 Python workers (~2.4 GB) on documents that never open chat | `a296904` | `chatEverShown` one-way latch gates the connect effect on first activation |
| `BoardView` measured `transitionDuration: 0s` — motion catalogue was never wired in | `b49ed4a` | Board cards now carry the move-band transition; catalogue applied |
| Schema-valid declaration crashed tool generation (`cap["entity"]` KeyError) | `b49ed4a` | `_entity_of()` falls back to `id`; regression test added |
| Approval-integrity false positive on `terminal` | `6715522` | Snapshot moved to the post-middleware boundary; middleware trail is diagnostic only and never affects the digest |
| Text "small and low-contrast" | `0589d32` | 28 sub-0.75rem instances raised to the `text-xs` floor; emphasis rule documented in `docs/design-tokens.md` |
| Sidebar said v0.18.2, `hermes --version` said v0.19.0 | `ae5b34d` | `provenance.runtime_identity()` reports imported-vs-installed version from one place; drift is named on screen and rolls into health |
| `variant="ghost"` silently ignored | `5ca9f17` | Fixed by you; merged |

Two things you flagged were **deliberately not done**, so don't re-file them:

- **The 97 gold-text uses.** Editing 97 sites blind would make coherence worse,
  not better. Instead the rule is now written down (`docs/design-tokens.md`:
  gold is permitted for exactly three things per surface — the primary action,
  the active state, and the one number that matters). New and touched surfaces
  conform; the back-catalogue converges as it's edited. If you think that's the
  wrong call, argue it in §F.
- **Manual NVDA acceptance** — deferred by agreement, still open.

---

## 1. Start here

```bash
cd <path-to>/hermes-agent
git checkout main
git pull origin main
cd web && npm install && npm run build
```

Then read, in this order:
1. `docs/imperator-mission.md` — what this app is and its invariants.
2. `docs/dashboard-modules.md` — **how we build every new surface.**
3. `docs/design-tokens.md` — tokens, motion bands, the emphasis rule.
4. `docs/plans/imperator-master-spec-checkpoint.md` — current state + phase plan.
5. Your own round-1 report, so you don't repeat measurements that still hold.

---

## A. Deploy, again — everything is blocked on this

Round 1 found the daily runtime on **port 9119 serving an older checkout than
`main`**. Confirm it is current *and stays* current.

1. Bring whatever serves :9119 to current `main`, rebuild the frontend, restart.
2. Open **Settings → System → Release**. You should now see three things:
   - backend and frontend commits **matching**, no drift banner;
   - a version line reading `v0.18.2 (…) · checkout` or `· installed`;
   - **the new "Two installs" banner** if a pip-installed `hermes-agent` wheel
     reports a different version than the checkout. Round 1 said `hermes
     --version` reports v0.19.0 while the checkout is 0.18.2 — **if that is
     still true, this banner must appear.** If it does not appear, that's a bug
     in `provenance.runtime_identity()`; report the raw JSON from
     `GET /api/system/provenance`.
3. Screenshot the Release card either way.

**Also answer:** *why* does the machine have a 0.19.0 wheel and an 0.18.2
checkout? Which one does the owner's `hermes` command actually run, and which
one does the dashboard serve? That divergence is the thing I most want
explained — see §G1.

---

## B. Verify the six fixes above, by measurement not by reading

Screenshot each; save under `docs/handoff/screens/`.

1. **PTY exhaustion.** This is the one that mattered most. Before opening
   anything, record `ps` counts of Node and Python workers. Then load, in one
   session: Dashboard → Jobs → Capabilities → a capability board → Settings →
   Review. **Do not open Chat.** Record the worker counts again. They must not
   grow. Then open Chat, confirm it still works normally, and record again.
   Report all three numbers.
2. **Motion.** Re-run the measurement that caught the regression: computed
   `transitionDuration` on a board card. It must be non-zero (240ms band) with
   motion on, and `0s` under `prefers-reduced-motion: reduce`. Do the same for
   a gallery card and an agenda row. Then, separately from the numbers: **does
   it look good?** The owner was explicit that screen-reader friendliness must
   not cost visual quality. Say plainly whether the app feels alive or flat.
3. **Text floor.** Confirm nothing renders below 12px. If you find any, list
   selectors.
4. **Approval integrity.** Exercise `terminal` and at least four other gated
   tool families. Confirm no false positives now. Report the verified/refusal
   denominator — this gates §C.
5. **Version identity.** Covered in §A.
6. **Capability tool generation.** Author a declaration *without* an `entity`
   field via the builder, approve it, and confirm its tools generate.

---

## C. Approval integrity → `enforce`

`approval_integrity` is still in `observe` mode because flipping it to `enforce`
without a representative live denominator risks blocking legitimate work. You
are the only one who can produce that denominator.

Drive the agent through **real** work across every gated family: file writes,
terminal, email send, calendar write, capability write, MCP/skill install. Then
report:

- total verified grants, total refusals, and every refusal with its cause;
- your recommendation: flip to `enforce` now, or what's still missing.

If and only if your numbers are clean, flip it and report the result. If
anything is ambiguous, leave it in `observe` and say why.

---

## D. Two design problems I can't see

Both came from your round-1 report. I need your eyes, not my guesses.

1. **Jobs density.** You wrote that the page shows "Today, nine counters, two
   quota bars, filters, and full cards before the user acts." Screenshot it at
   the owner's actual desktop resolution. Then propose a concrete hierarchy:
   what is the *one* thing that surface should say first, what collapses behind
   a disclosure, and what should be deleted outright. Don't implement it yet —
   propose, with a screenshot marked up if you can.
2. **Gallery emptiness.** "Large empty columns and sparse cards." Same
   treatment: screenshot, then say whether the fix is card sizing, column
   count, content density, or that gallery is simply the wrong default view for
   the data the owner actually has.

**Desktop-first.** The owner corrected this explicitly: judge every layout at
desktop width first. Mobile matters, but it is not the primary case.

---

## E. The smart-approval reasoning gap

This is a design problem I created and can't resolve alone.

The approval card was designed to show the agent's *verdict plus its reasoning*
— why it thinks an action is safe. But the protocol doesn't carry reasoning:
`_smart_approve()` asks the model for one word and discards everything else.
So the card promises an explanation the system never produces.

Three ways out:

1. **Change the protocol** — ask for a short structured justification alongside
   the verdict, and surface it. Costs tokens and latency on every gated call.
2. **Change the card** — stop promising reasoning; show only what we actually
   have (the tool, its arguments, the tier, the scope).
3. **Reconstruct locally** — derive a rationale from the permission tier and
   guardrail signals without asking the model at all.

Read `_smart_approve()` and the approval card as they exist on your machine,
then tell me which you'd ship and why. If you pick (1), measure what a
justification actually costs on the owner's real model. Your call carries
weight here — you can run the real agent and I can't.

---

## F. Judgement I'm asking for

Answer these in the report, plainly, in your own words:

1. Was the "document the gold rule instead of sweeping 97 sites" call right?
2. After using the app for real work, what is the **single worst** remaining
   thing about it? Round 1's answer was PTY exhaustion and it was correct.
3. What did I build that you don't think the owner will ever use?
4. What's missing that you'd expect a personal intelligence hub to have?

---

## G. Questions only you can answer

The owner asked me to ask you things that would genuinely improve the app.
These are those things. Please answer each explicitly.

1. **The two installs.** Explained in §A. Which Hermes should be canonical on
   this machine — the wheel or the checkout — and what breaks if we standardise
   on one?
2. **Real usage shape.** What does the owner *actually* do with this app on a
   normal day? Which surfaces get opened, which never do? I have been building
   to a spec; you can see behaviour.
3. **The volatile context tier.** The locked architecture pulls volatile
   context via a `hub_context` tool rather than putting it in the system prompt.
   In real use, does the agent *call* it when it should? If it doesn't, the
   architecture is right but the affordance is wrong, and I need to know.
4. **Latency.** Where does the app feel slow on real hardware? Name surfaces
   and rough numbers, not impressions.
5. **Gmail/Calendar polling.** What's the real cadence, and does the polling
   interval produce staleness the owner notices?
6. **Voice.** Has native voice been exercised end to end? Does it work?
7. **What would you build next?** If the next increment were yours to choose —
   not from my phase plan, from what you've observed — what is it?

---

## H. Out of scope this round

Do not start these; they're sequenced deliberately.

- Media & Jobs migration to plugins — deferred by the owner to the very end.
- The native structured chat client (replacing the PTY path) — large, and it
  should land after §C and §E are settled.
- Renderer breadth (calendar/timeline/chart views, formula/rollup fields).

---

When you're done: overwrite `docs/handoff/imperator-report.md`, commit, and push
to `main`. Then tell the owner it's ready to bring back.
