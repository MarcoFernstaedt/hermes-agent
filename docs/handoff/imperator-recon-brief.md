# Imperator — Recon Brief for the On-Machine Agent

**You are an agent running on the owner's actual machine.** A separate Claude
session has been building Imperator in the cloud, where it *cannot* see the live
app, run the real chat (no model key there), take screenshots, or inspect the
owner's system and connected accounts. Your job is to gather everything that
session needs and **write the answers to a report file** so it can finish the
work and verify nothing is broken.

Do **not** guess or fabricate. If something can't be determined, say
"unknown" and why. Never print secret *values* — report only whether a secret
is present/configured.

---

## 0. First steps

```bash
cd <path-to>/hermes-agent
git checkout main
git pull origin main          # get the latest; retry on transient network errors
```

Then create your report at `docs/handoff/imperator-recon-report.md` (or paste it
back into chat). Answer every numbered item below. Keep it factual and terse.

**Key facts (from the cloud session, verify they still hold):**
- Repo: `MarcoFernstaedt/hermes-agent`, default branch `main`. Active feature
  branch: `claude/imperator-dashboard-mobile-xw09ri` (kept fast-forward-merged
  into `main`).
- Dashboard server entry: `hermes_cli/web_server.py` → `start_server(host, port=9119, open_browser=...)`.
- Data home: `hermes_constants.get_hermes_home()` — honors `HERMES_HOME`,
  else `~/.hermes`. SQLite DBs, OAuth token store, and state JSON live under it.
- Frontend builds from `web/` to `hermes_cli/web_dist/` (gitignored — must be
  built locally: `cd web && npx vite build`).
- Auth header for API calls: `X-Hermes-Session-Token` (injected into the SPA as
  `window.__HERMES_SESSION_TOKEN__` on loopback binds).

---

## 1. Build & test health (run these, paste output/tails)

1.1 Python tests green?
```bash
.venv/bin/pytest tests/hermes_cli/test_agent_scopes.py \
  tests/hermes_cli/test_agent_scopes_router.py \
  tests/hermes_cli/test_approval_integrity.py -q
```
Then a broad run of the suite you can afford; report pass/fail counts and any
failures (name + short reason).

1.2 Frontend gate from `web/`:
```bash
cd web && npx tsc --noEmit && npx eslint src && npx vitest run && npx vite build
```
Report each step's result. If `vite build` warns about chunk size only, that's
pre-existing — note it and move on.

1.3 Does the dashboard launch and serve? Start the server, load it in a browser,
confirm it renders. Report the exact launch command you used and the URL/port.

---

## 2. Live-app verification + screenshots

Take screenshots (attach them / save under `docs/handoff/screens/`) and confirm
each works. For anything broken, capture the console error and network failure.

2.1 **Global stop** — in the left sidebar there is a "Stop agent" control
(bottom cluster, above system actions). Click it → it should flip to a red
"Agent halted" banner; while halted, the agent must refuse tool calls. Click
"resume" → returns to normal. Screenshot both states. Confirm the state
persists across a page reload (it's server-side).

2.2 **Session scope indicator** — the guardrails API is `GET /api/agent/guardrails`.
Confirm it returns `scopes`, `default_scope`, `halted`, `approval_integrity`.
Note whether the UI surfaces the per-session scope anywhere yet (it may not —
that's expected; report what you see).

2.3 **Capability boards** — for each capability route (`/c/<id>`; the nav lists
them), load it directly (type the URL, don't just click) and confirm it renders
the board/table and that create/advance actions work. List which capability ids
exist and whether each renders. This directly checks the dynamic-route fix.

2.4 **Media / Spotify re-auth** — open the Media area's Spotify connection card.
If disconnected or token-expired, confirm the "Reconnect Spotify" button opens
the OAuth flow and that after completing it the card shows connected. Report
whether `SPOTIPY_CLIENT_ID` (or equivalent) is configured; if not, the card
should show actionable guidance, **not** a 500. Screenshot.

2.5 **Chat / gateway** — the cloud session cannot test this (no model key). Send
a real chat message, confirm the agent responds, approvals prompt correctly, and
tool calls stream. Report the model/provider in use and any errors.

---

## 3. Approval integrity — THE decision that unblocks enforcement

The cloud session shipped `hermes_cli/approval_integrity.py` in **observe mode**
(env `HERMES_APPROVAL_INTEGRITY`, default `observe`). It snapshots the payload of
every human-gated (non-AUTO) tool call at approval time and re-checks it at
dispatch. In `observe` it only writes an audit row on a mismatch; in `enforce`
it refuses the call. **We need real-app evidence before flipping to `enforce`,**
because legitimate middleware transforms could theoretically change args between
approval and dispatch and cause false refusals.

3.1 Run the app normally for a bit, triggering several **approval-gated** actions
(a file write, an email label/send if configured, a terminal command needing
approval). Approve them as usual.

3.2 Query the audit log for integrity events:
```bash
# via the app's audit surface, or directly:
sqlite3 "$(python -c 'from hermes_constants import get_hermes_home;print(get_hermes_home())')/audit_log.db" \
  "SELECT ts,tool,action,outcome,detail FROM audit_log WHERE module='approval_integrity' ORDER BY id DESC LIMIT 50;"
```
Report **how many** `payload_changed_after_approval` rows appeared and for which
tools. **Zero across a representative set of approvals = safe to enable
`enforce`.** Any hits: paste the tool + detail so the cloud session can see
which middleware legitimately mutates args and special-case it.

3.3 Recommendation you should state explicitly in the report: **"enforce is
safe"** or **"stay on observe because tools X,Y show benign mismatches."**

---

## 4. System, accounts & data state (presence only — never values)

4.1 **Connected providers** — which are connected: Spotify, Gmail, Google
Calendar, any others? For each: connected? scopes? token present under the home
dir's token store? (presence only).

4.2 **Vault / Obsidian** — is a vault path configured? Where? Does the app treat
it as read/write? (Rule: the vault is Obsidian's store, never the app's — confirm
nothing writes app data into it.)

4.3 **Model / API keys** — which model providers are configured (Anthropic,
OpenAI, OpenRouter, …)? Presence only. This tells us whether gateway chat and
agent turns can run.

4.4 **Data home inventory** — list the sqlite DBs and state JSON under the home
dir and their rough sizes:
```bash
ls -la "$(python -c 'from hermes_constants import get_hermes_home;print(get_hermes_home())')"
```
Note especially: `entities.sqlite3`, `audit_log.db`, `jobs`/life DBs,
`state/agent-guardrails.json` (the scopes+halt store).

4.5 **OS / runtime** — OS + version, Python version, Node version, how the app is
normally launched (script? service? terminal?), and whether it runs desktop-only
(the current design target) or also on phone.

---

## 5. Open questions for the owner (answer if you know, else flag)

5.1 Should approval integrity default to `enforce` once §3 shows it's clean?
5.2 For the next increments (rate-limit + anomaly + outbound secret-scan, then
daily briefing, automation rules, usage adaptation): any per-category
send/write/delete ceilings the owner wants, or should the cloud session propose
defaults?
5.3 Any surfaces currently broken or annoying in daily use that should jump the
queue? (This is the highest-value thing you can collect — real usage friction.)
5.4 Confirm the desktop-only direction still holds (no mobile work needed).

---

## 6. What's already shipped vs pending (so you know the frame)

**Shipped & tested (cloud):**
- Session capability scopes + server-enforced **global stop** (refused at the
  `registry.dispatch` chokepoint; stop is unconditional).
- **Approval integrity** in observe mode (this brief's §3 gates enforcement).
- Earlier: capability modules, entity store + link graph, Jobs/Progress agent
  tools, Spotify in-dashboard re-auth, modules-as-manifests.

**Pending (planned in `docs/plans/imperator-adaptive-hardening-response.md`):**
rate-limit + anomaly + outbound secret-scan → daily briefing + review-queue
suggestions → automation rules (one event-bus engine) → usage adaptation (off by
default).

**Externally blocked (needs this machine):** gateway chat E2E (needs a model
key — §2.5, §4.3), and turning Media/Jobs-UI into *removable* dashboard plugins
(needs a JS-bundle build pipeline that doesn't exist in-repo).

---

## 7. How to return the results

Write `docs/handoff/imperator-recon-report.md` with your answers to §1–§5,
attach screenshots (§2), and either commit it on a branch and push, or paste the
report back into chat. Lead with the **three things that most change the plan**:
(a) the §3 enforce recommendation, (b) whether a model key is configured, and
(c) any broken surface from §5.3.
