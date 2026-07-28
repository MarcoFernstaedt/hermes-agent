# Imperator — Work Order for the On-Machine Agent

**Supersedes every previous version of this file.** Ignore anything you
remember from the earlier brief; the repo has moved on substantially.

You are an agent running on the owner's actual machine. A Claude session builds
Imperator in a cloud container that **cannot** see the live app, run the real
agent (no model key there), take screenshots, or touch the owner's system. This
file is the interface between the two of you.

This is a **work order**, not just a survey. Sections A–D are things to *do*.
Section E is judgement I'm asking for. Write everything to
`docs/handoff/imperator-report.md` and push it.

Ground rules: never print secret **values** (presence only). If something can't
be determined, write "unknown" and why — do not guess. If you disagree with
something here, say so in the report; you can see things I can't.

---

## 0. Start here

```bash
cd <path-to>/hermes-agent
git checkout main
git pull origin main
```

Then read, in this order:
1. `docs/imperator-mission.md` — what this app is and its invariants.
2. `docs/dashboard-modules.md` — **how we build every new surface.**
3. `docs/design-tokens.md` — tokens, motion, the conformance rule.
4. `docs/plans/imperator-master-spec-checkpoint.md` — current state + phase plan.

---

## A. Deploy — this is the top priority, everything else is blocked on it

The last recon found the daily runtime on **port 9119 serving an older checkout**
than `main`. That means roughly fifteen merged increments — the entire guardrail
layer, the review queue, capability authoring, the accessibility fixes — **do not
exist for the owner.** Nothing else in this file matters until this is fixed.

1. Identify what serves :9119 (process, working directory, service unit).
2. Bring that checkout to current `main` and rebuild the frontend:
   ```bash
   cd web && npm install && npm run build     # emits build-info.json + web_dist
   ```
3. Restart the service from that checkout.
4. Open **Settings → System → Release**. Backend and frontend commits must match
   and the drift banner must be **gone**. Screenshot it.
5. If any step needs a decision you can't make safely (a service file you don't
   own, a port conflict), stop and report — do not improvise around it.

**Report:** the exact commands, the before/after commits, and confirmation the
drift banner cleared.

---

## B. Verify what shipped (screenshot each; save under `docs/handoff/screens/`)

All of this is on `main` and untested by a human. For anything broken, capture
the console error and the failing network request.

- **B1 Global stop** — sidebar control. Engage → red "Agent halted" state; the
  agent must refuse tool calls while halted. Reload → state persists (it's
  server-side). Release. **This must work on :9119, not just a test server.**
- **B2 Session scope** — chat header has a scope control (Full / Read-only /
  Research / Triage). Change it; confirm it persists per session. In Read-only,
  confirm a write tool is actually *refused*, not merely hidden.
- **B3 Review queue** (`/review`) — should render, empty is fine. Check the
  "Inspect exactly what will happen" disclosure works.
- **B4 Capability builder** (`/capabilities/new`, linked from Review) — build a
  throwaway capability: pick a **Template**, tick **Gallery**, set an **Agenda by**
  date field. Confirm live validation errors appear and clear. Propose it →
  approve it in Review → **confirm the new surface appears at `/c/<id>` and is
  usable**. Then delete the declaration from `~/.hermes/capabilities/` to clean up.
- **B5 The four view kinds** — on that capability (or `/c/tasks`, `/c/contacts`,
  `/c/reading`): board, table, gallery, agenda. Confirm agenda groups by day,
  shows "Today", and puts undated records in a "No date" group rather than
  dropping them.
- **B6 Motion** — confirm it looks *good*, not just correct: rows fade+rise on
  arrival, a card travels when it changes column, live updates warm gold briefly.
  Then set OS reduced-motion and confirm all of it becomes instant **with nothing
  lost**. This was a real bug fixed recently; verify the fix.
- **B7 Jobs "Today — ready to apply"** — top of `/jobs`. Should list real
  packet-ready roles; "Open application" and "Mark applied" both work.
- **B8 Spotify** — Media connection card. If the token is healthy, say so; if you
  can safely test the reconnect flow, do.
- **B9 Chat** — the existing chat still works end to end (send, stream, approve).
  Report the reliability defects from last time: does a response still duplicate,
  does a second client still time out?

---

## C. The decisions I need before I can write more code

### C1. Approval integrity → `enforce`? (the one I most need)

`hermes_cli/approval_integrity.py` runs in **observe** mode. It now fails closed,
rejects replays, and — new — writes a `verified` audit row on every *successful*
gated call, which gives the denominator that was missing last time.

Do this:
1. Use the app normally for a while, triggering **several approval-gated actions**
   (a file write, a terminal command needing approval, an email label if
   configured). Approve them as usual.
2. Then:
```bash
sqlite3 "$(python -c 'from hermes_constants import get_hermes_home;print(get_hermes_home())')/audit_log.db" \
  "SELECT action, outcome, COUNT(*) FROM audit_log WHERE module='approval_integrity' GROUP BY action, outcome;"
```
3. Report the counts. **`verified` rows with zero `payload_changed_after_approval`
   rows across a representative set ⇒ enforce is safe.** Any mismatches: paste the
   tool and detail so I can see which middleware legitimately mutates args.
4. State plainly: **"enforce is safe"** or **"stay on observe because X."**

### C2. Hermes version and the two protocols

The next big build is the **native structured chat client**, and I will not write
it against assumptions.

- Confirm the installed Hermes version (expected **v0.19.0 "Quicksilver"**). If
  older, update first and say so.
- From the installed source, report the **actual** tui_gateway method and event
  catalogue (`tui_gateway/server.py`) — names and payload shapes.
- Confirm whether **smart-approval verdicts** (the LLM reviewer's judgement +
  reasoning) are carried on the approval event. The approval card design depends
  on this. If they aren't, say where they *are* available.
- Confirm the plugin registration contract in your version: what
  `PluginContext.register_*` accepts, and that dashboard tabs are still the
  `dashboard/manifest.json` mechanism.

### C3. Guardrail calibration

Rate ceilings ship in **observe** (`HERMES_AGENT_RATE_LIMIT`), outbound
secret-scan in **enforce**. Check for false positives:

```bash
sqlite3 ".../audit_log.db" "SELECT action, outcome, COUNT(*) FROM audit_log WHERE module='agent_guards' GROUP BY action, outcome;"
```

Report any `outbound_secret_detected` that was a **false alarm**, and whether the
default ceilings (write 400/h, send 40/h, delete 60/h) are sane for real use.

---

## D. Accessibility — only you can do this

The CI tripwire catches missing accessible names and alt text. It cannot replace
a real reader. The owner uses **NVDA as a primary interface**.

- **D1 NVDA in Chrome *and* Firefox** (they differ): the shell, `/review`,
  `/capabilities/new`, a board, a table, a **gallery**, an **agenda**, and chat.
  Report per surface: does browse/focus mode behave, are headings navigable by
  rotor, do live regions announce meaningfully rather than spam?
- **D2** The agenda view is designed as the *accessible-first* date surface, with
  real per-day headings. Confirm heading navigation actually jumps day to day.
- **D3** Any place NVDA gets trapped, goes silent, or reads something misleading.
  This is the highest-value bug class you can find.
- **D4** If VoiceOver is available, spot-check; if not, say so.

---

## E. Your judgement — be specific and opinionated

You see the running app and the owner's real habits. Cite what you observed.

1. **The three worst flows** right now, and the shorter path for each.
2. What the owner still does **outside** Imperator that it could absorb.
3. Which surfaces are **dead** (never opened) and should be proposed for retirement.
4. **Tool ergonomics**: which agent tools are missing, awkwardly named, or return
   unactionable errors? Where did you fall back to raw shell because no tool fit?
5. **Data realities**: rough counts per module, and anything that will lag at the
   owner's real volume.
6. **Does it look good?** The app is meant to feel alive and expensive — layered
   obsidian, gold used sparingly for the one thing that matters, caused motion.
   Be honest if it looks flat, cluttered, or cheap, and say where.
7. **Anything I didn't ask** that you think matters.

---

## F. How to report back

Write `docs/handoff/imperator-report.md`, commit on a branch, push:

```bash
git checkout -b imperator/report-2
git add docs/handoff/
git commit -m "On-machine report: deploy, verification, decisions"
git push -u origin imperator/report-2
```

**Lead the report with these four**, because they decide what I build next:

1. **Deploy** — did :9119 come current, is drift gone?
2. **Enforce** — approval-integrity counts and your recommendation (C1).
3. **Protocols** — Hermes version + the real gateway catalogue (C2).
4. **The worst thing** you found — broken, ugly, or slow.

Then everything else in order. Don't skip section E; it's the part that most
changes what gets built.
