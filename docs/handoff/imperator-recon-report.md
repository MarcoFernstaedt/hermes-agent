# Imperator on-machine recon report

Date: 2026-07-27

Candidate repository: `MarcoFernstaedt/hermes-agent`

Candidate worktree: `/home/marco/imperator-workspace/worktrees/hermes-imperator-recon`

Candidate commit: `40fe882395d7a73e28396712b4e130d472bc5d19`

## The three facts that change the plan

1. **Do not flip approval integrity to `enforce`. Stay on `observe`.** The current code does not bind the hash record to a confirmed human grant, permits missing/expired/consumed records in enforce mode, and has no representative live approval denominator. The broad suite also fails two ACP approval-callback regression tests, and a synthetic integrity test wrote into the live audit database.
2. **No classic model API key is configured.** Active model access is usable through configured OpenAI Codex OAuth: provider `openai-codex`, model `gpt-5.6-sol`. A real dashboard chat returned the requested text. Never infer "no model access" from "no API key."
3. **The normal daily dashboard runtime is not this candidate.** The installed checkout serving port 9119 is at `d63a1c4ccb1c06f3d5ed187136f36b6df3858fcd`, while this report verifies candidate `40fe8823...` on port 9122. The older runtime returned 404 for the guardrails API. On the candidate, chat is also inconsistent: the interactive browser rendered the same assistant response twice, while an independent Playwright chat run timed out after 180 seconds.

## Ranked recommendations

1. **Repair the approval grant boundary and audit telemetry before enforcement.** Record only after an actual human grant; fail closed for missing/stale/replayed records; count successful verified approvals by tool; isolate tests from the live audit DB.
2. **Eliminate release drift.** Promote one verified checkout/build to the normal service and expose its commit in the UI; do not let daily use silently remain on an older checkout.
3. **Fix chat deduplication, reconnect, and persistence E2E.** One browser showed a duplicated response and another timed out on the same candidate server.
4. **Make Jobs/Progress the single screen-reader-first daily command view.** Put the top three income actions and one quick-capture action there instead of adding more boards.
5. **Preserve stable navigation and curated-data boundaries.** Remove duplicate sidebar destinations, keep usage reordering opt-in, and connect Obsidian only through an explicit read-mostly boundary with indexed search.

## 1. Build and test health

### 1.1 Python

- The brief's literal `.venv/bin/pytest ...` command could not run because this worktree has no `.venv` directory.
- Equivalent cache/bytecode-disabled command used system Python with the installed test dependencies:

```text
PYTHONDONTWRITEBYTECODE=1 python3 -m pytest -p no:cacheprovider \
  tests/hermes_cli/test_agent_scopes.py \
  tests/hermes_cli/test_agent_scopes_router.py \
  tests/hermes_cli/test_approval_integrity.py -q
........................ [100%]
24 passed in 6.33s
```

- Broad suite: **FAIL / incomplete**.
  - A full `python3 -m pytest -p no:cacheprovider -q` run reached about 71 percent before the 600-second bound, with 9,686 passed, 179 skipped, and two failures already present; no final suite total is claimed.
  - A bounded `--maxfail=2` reproduction ended with `2 failed, 6 passed, 2 skipped, 65 deselected` in 42.82 seconds.
  - Failures:
    - `tests/acp/test_approval_isolation.py::TestAcpExecAskGate::test_interactive_env_var_routes_to_callback`
    - `tests/acp/test_approval_isolation.py::TestAcpExecAskGate::test_interactive_context_var_routes_to_callback_without_env`
  - Both failures have the same security-relevant symptom: dangerous commands in interactive mode bypassed the registered approval callback (`called_with` remained empty), contradicting the GHSA-96vc-wcxf-jjff regression expectations.
  - Six collection/unknown-mark warnings were also emitted. The broad Python suite is therefore not green.

### 1.2 Frontend gate

Run from `web/`:

- `npx tsc --noEmit`: PASS, exit 0.
- `npx eslint src`: PASS, exit 0.
- `npx vitest run`: PASS, 45 files and 271 tests.
- `npm run build` (`tsc -b && vite build`): PASS, 997 modules transformed, built in 3.64 seconds.
- Build warning only: the main JavaScript chunk is about 1.24 MB minified, above Vite's 500 kB warning threshold. No build failure.

### 1.3 Dashboard launch

Candidate launch command:

```text
python -c "from hermes_cli.web_server import start_server; start_server(host='127.0.0.1', port=9122, open_browser=False)"
```

- URL: `http://127.0.0.1:9122/`
- Process working directory: the candidate worktree named above.
- The page served HTTP 200 and rendered the Imperator shell.
- Launch screenshot: [`screens/01-home.png`](screens/01-home.png)
- The candidate server was intentionally separate from the normal port-9119 runtime.

## 2. Live application verification

### 2.1 Global stop

PASS on the candidate server.

- Normal state rendered.
- Clicking Stop agent produced the red Agent halted state.
- The halted state remained visible after a full reload, proving server-side persistence.
- The agent was resumed after the test; current state is `halted: false`.
- Focused server-side tests covering the registry dispatch stop path passed.

Screenshots:

- [`screens/02-global-stop-normal.png`](screens/02-global-stop-normal.png)
- [`screens/03-global-stop-halted.png`](screens/03-global-stop-halted.png)
- [`screens/04-global-stop-halted-after-reload.png`](screens/04-global-stop-halted-after-reload.png)

Important deployment fact: the normal daily runtime on port 9119 returned 404 for `/api/agent/guardrails`; the candidate on 9122 returned 200.

### 2.2 Session scope indicator

`GET /api/agent/guardrails` on the candidate returned HTTP 200 with all requested top-level fields:

- `scopes`
- `default_scope`
- `halted`
- `approval_integrity`

Observed values:

- Four named scopes exist.
- Global state was not halted after cleanup.
- Approval integrity mode was `observe`.

The UI does **not** visibly show the active per-session scope in the chat header or sidebar. That remains an expected but real visibility gap.

### 2.3 Capability boards

Discovered capability IDs:

- `contacts`
- `reading`
- `tasks`

All three direct routes rendered at `/c/<id>`. For each board, a disposable record was created, advanced, visually confirmed, and removed. No test records were intentionally left behind.

Screenshots:

- [`screens/capability-contacts-direct.png`](screens/capability-contacts-direct.png)
- [`screens/capability-contacts-create-advance.png`](screens/capability-contacts-create-advance.png)
- [`screens/capability-reading-direct.png`](screens/capability-reading-direct.png)
- [`screens/capability-reading-create-advance.png`](screens/capability-reading-create-advance.png)
- [`screens/capability-tasks-direct.png`](screens/capability-tasks-direct.png)
- [`screens/capability-tasks-create-advance.png`](screens/capability-tasks-create-advance.png)

### 2.4 Media and Spotify re-auth

Spotify is connected; no disconnect/reconnect mutation was needed.

- OAuth token: present.
- Client identifier: configured.
- Live Spotify API probes returned HTTP 200 for account, saved tracks, playlists, and recent activity.
- The candidate Media card showed Connected and displayed a Reconnect control.
- Because the token was healthy, the OAuth flow was not deliberately invalidated. The expired-token recovery branch remains untested in this recon.

Screenshot: [`screens/spotify-connection.png`](screens/spotify-connection.png)

### 2.5 Chat and gateway

Partial pass with a reproducible reliability defect.

- Provider: `openai-codex`.
- Model: `gpt-5.6-sol`.
- Authentication: OAuth credential present; no classic API key.
- Interactive browser test message received the exact requested response, proving model access and gateway generation work.
- The assistant response rendered twice in the interactive browser.
- A separate Playwright browser sent another exact-response probe and timed out after 180 seconds waiting for the response.
- Earlier screenshot evidence captured the chat stuck in Sending state.
- No console JavaScript exception was present in the successful interactive browser.

Screenshots:

- [`screens/chat-live.png`](screens/chat-live.png)
- [`screens/chat-response.png`](screens/chat-response.png)

Approval prompts and streamed tool calls were **not** declared clean: no representative non-preauthorized human-gated action was available without conflating this already-approved recon mission with a fresh consent decision. That missing evidence is part of the `observe` recommendation.

## 3. Approval integrity decision

### Recommendation

**Stay on `observe`. Enforce is not safe at this commit.**

### Evidence and denominator

Before synthetic approval-integrity probes:

- Total audit rows: 0.
- Approval-integrity rows: 0.
- Representative live human-approved gated actions proven end-to-end: 0.
- Mismatch ratio: undefined, not 0 percent.

After the focused synthetic probe, the live audit DB contained one row:

```text
tool=write_file
action=payload_changed_after_approval
outcome=refused
detail={"enforced": true, "tool_call_id": "[SYNTHETIC TEST ID OMITTED]"}
```

This is not evidence of a real user's approved action. Its timestamp matches the synthetic enforce-mode mismatch probe. It also demonstrates that the test/import path can write to `/home/marco/.hermes/audit_log.db` despite a temporary-home fixture, so the audit database currently mixes test and production evidence.

### Production-path defects

1. `record_grant(...)` is called in `model_tools.handle_function_call` before the pre-tool approval hook resolves. It records every non-AUTO call, not a confirmed human grant.
2. `verify_at_execution(...)` returns allow when no record exists, even in enforce mode. Missing, expired, cleared, or already-consumed records therefore fail open.
3. A record is single-use, but a replay after consumption is allowed because the second lookup finds no record.
4. Exceptions around both record and verify paths are swallowed and permit execution.
5. The audit table records mismatches only. It cannot provide the denominator of successful verified approvals by tool.
6. Denied or timed-out calls are not visibly bound to deterministic integrity-record cleanup in the reviewed boundary.

### What is good

- Canonical hashing is order-independent and includes the tool name.
- A changed payload is refused when a record exists and mode is enforce.
- Records have a TTL and bounded in-memory storage.
- The focused unit tests passed.

### Required gate before enforce

- Move grant recording to the confirmed approval outcome, after the exact payload presented to the human is fixed.
- Make an expected gated call with no valid grant record fail closed.
- Add stale, replay, denial, timeout, middleware-transform, restart, and multi-process tests.
- Record successful verify events without storing payloads, so every tool has a numerator and denominator.
- Run representative safe fixture approvals for file write, terminal, email/calendar, and vault writes against the exact release candidate.
- Prove rollback from enforce to observe.
- Isolate all tests from the live audit DB.

## 4. System, accounts, and data state

### 4.1 Connected providers and accounts

Presence only:

- OpenAI Codex: configured through OAuth; active and usable.
- Spotify: OAuth token present and live API calls returned 200. Configured scopes include playback read/control, recent activity, library, and playlist access.
- Gmail: Google refresh token present; candidate UI showed Connected.
- Google Calendar: same Google credential set; candidate UI showed Connected.
- Google Gemini OAuth material: present, but not the active model provider for this recon.
- Telegram: connected.
- Discord: connected.
- API server: connected.
- ntfy: connected.
- Feishu: connected.
- No secret values were copied into this report.

### 4.2 Vault and Obsidian

- Actual vault exists at `/home/marco/obsidian-vault`.
- Rough size: 6,841 files, 733 Markdown notes, about 85 MB total.
- Candidate app vault path: **not configured**. The Vault route showed No vault configured.
- Candidate vault code supports reads and carefully gated atomic note writes, but no candidate route can touch the real vault until a path is explicitly configured.
- Current boundary remains correct operationally: app databases, logs, state, and test artifacts stay under Hermes/workspace storage, not in Obsidian. Routine app state was not found being written into the vault.

### 4.3 Models and keys

- Active provider: `openai-codex`.
- Active model: `gpt-5.6-sol`.
- OpenAI API key: absent.
- Anthropic API key: absent.
- OpenRouter API key: absent.
- Other classic model API keys checked: absent.
- OpenAI Codex OAuth credential: present and usable.
- Google Gemini OAuth credential: present.
- Result: gateway chat and agent turns can run without a classic model key.

### 4.4 Data-home inventory

Resolved home: `/home/marco/.hermes`.

SQLite files checked read-only; each reported `quick_check=ok`:

- `state.db`: about 579 MB; 26,133 messages at the final inventory point, with FTS parity.
- `audit_log.db`: 20 KB; one synthetic approval-integrity row after this recon's probe.
- `verification_evidence.db`: about 692 KB; 273 verification events and 280 current-state rows.
- `cron/executions.db`: about 573 KB; 1,000 retained execution rows.
- `oauth_tokens.db`: 12 KB; one token record.
- `kanban.db`: about 9.7 MB; current root task tables empty.
- `projects.db`: 45 KB; 12 projects and 14 project folders.
- `response_store.db`: 20 KB; empty.
- `state/entities.sqlite3`: 49 KB; zero entities and zero links.
- `state/life-progress.sqlite3`: 45 KB; six habits, zero entries/reflections/progress events.
- `visitor-analytics/visitors.sqlite3`: 32 KB; 18 visits.

Relevant JSON state includes:

- `state/agent-guardrails.json`: 17 bytes; `halted: false`.
- `gateway_state.json`: 878 bytes.
- `channel_directory.json`: 1.6 KB.
- Provider/model caches, restart state, voice mode, and bounded workflow state.
- Secret-bearing auth/token JSON files exist with owner-only permissions where expected; values are omitted.

Additional real-volume data:

- Obsidian job-search SQLite: 258 jobs, 253 packets, 1,012 assets, and 61,667 validation events.
- Job lead intake JSON: 16 leads, zero marked Review now at inspection time.
- Spotify: 700 saved tracks, 9 playlists, 50 recent items returned by the bounded probe.
- Candidate Email UI displayed 100,789 unread messages, which is likely too large/noisy to be a useful task count without filtering.
- Remote calendar-event count was not safely established; connected status was established.

### 4.5 OS and runtime

- OS: Debian GNU/Linux 13.6.
- Kernel: Linux `6.12.95+deb13-amd64`.
- Architecture: x86-64.
- Python: 3.11.15.
- Node: 22.22.1.
- Normal dashboard launch: a long-running Hermes process serving port 9119 from `/home/marco/hermes-agent`.
- Candidate launch: separate Python process on loopback port 9122 from the recon worktree.
- Ollama CLI and service unit are installed, but the service is inactive and disabled. No usable local model was verified.
- The machine is headless for this session: no desktop display variable was present. Access is through browser/dashboard and messaging channels.

## 5. Open questions for the owner

### 5.1 Approval integrity default

Do not default to enforce yet. Once the grant-boundary, fail-closed, telemetry, and representative-live gates in §3 pass, enforce should become the default with a documented observe rollback.

### 5.2 Send/write/delete ceilings

No new numeric ceilings were specified in this request. The next implementation should propose conservative per-category defaults:

- Sends to new audiences, money, credential changes, destructive operations, and client systems: explicit approval every time.
- Deletes and destructive Git: explicit approval every time; no batching by default.
- Routine reversible local writes inside an approved mission: allowed, but receipt/audit recorded.
- External write batches: bounded item count and recipient/domain ceilings, with an approval preview.
- Healthy/no-op checks: silent and rate-limited.

### 5.3 Broken or annoying daily-use surfaces

Priority order:

1. The normal runtime is stale relative to the candidate and lacks the candidate guardrails endpoint.
2. Candidate chat is unreliable across browser clients and duplicated one assistant response.
3. The sidebar exposes duplicate destinations such as Cron, Projects, and Profiles, which is especially confusing for screen-reader navigation.
4. Email's 100,789 unread badge is not actionable triage.
5. The actual Obsidian vault exists but the candidate Vault route is unconfigured, so app search cannot use that curated reference store.

### 5.4 Desktop-only direction

Do **not** treat desktop-only as an owner requirement. The native desktop app can remain the implementation target for OS integrations, but the owner's established operating preference is screen-reader and iPhone-first, with Telegram and the native dashboard as control surfaces. Mobile-accessible responsive behavior still matters; a separate mobile app is not required by this recon.

## 6. Agent recommendations from direct use

### 6A. Real usage and friction

Most relevant known surfaces:

- Telegram is the always-available command surface.
- Dashboard Progress/Jobs should be the daily focus surface because income/runway is the active priority.
- Email and Calendar are connected and useful but currently secondary.
- Entities, root Kanban, and new capability boards contain little or no durable real data; they look new or unused.
- Vault is not connected in the candidate.

Three worst flows and shorter paths:

1. **Release drift:** latest features require a second server/worktree. Ideal: one signed/verified release command updates the canonical service, displays the exact commit, and supports one-command rollback.
2. **Chat reliability:** a basic message can duplicate or stall. Ideal: idempotent turn IDs, visible reconnect state, one persisted response, retry/cancel controls, and an E2E test against the running gateway.
3. **Income context is fragmented:** jobs, packets, email replies, and notes span JSON, SQLite, Obsidian, and inbox views. Ideal: one Jobs/Progress screen that presents the top three actions, recent replies, blockers, and one accessible quick-capture field.

Outright defects/confusion:

- Candidate chat duplicated the requested response in one browser.
- Independent Playwright chat timed out after 180 seconds.
- Normal port 9119 returned 404 for the new guardrails route.
- Duplicate sidebar destinations create screen-reader noise.
- Search over the real 733-note vault is unavailable because the vault is not configured; current vault implementation is a linear scan and would be the likely future lag point.

Single highest-value daily-use change: make Jobs/Progress the fast, accessible morning command screen with the top three income actions and direct links into the relevant reply/application context.

### 6B. Agent and tool ergonomics

- Missing: a first-class release/provenance tool that reports running commit, built-asset commit, service unit, health, and rollback target together.
- Missing: a safe dashboard E2E tool that can create an isolated chat session, wait on gateway events, capture a persistent screenshot, and clean up.
- Awkward: model credential status is split between environment variables, OAuth stores, and provider config. One redacted `auth status` surface should report key absent/OAuth usable without exposing values.
- Ambiguous: duplicate nav labels do not tell a screen reader which Cron/Projects/Profiles destination is the product surface versus configuration/docs.
- Too permissive: approval-integrity enforce mode allows calls with missing records.
- Excessive prompts were not demonstrated in this run; the current standing-autonomy policy appropriately avoids prompting for ordinary reversible local work.
- The most unactionable error was the chat timeout: it had no visible cause or retry diagnosis.

### 6C. Data realities

Rough counts:

- Email unread badge: 100,789.
- Job-search DB: 258 jobs, 253 packets, 1,012 assets, 61,667 validation events.
- Job lead JSON: 16 leads.
- Entities: 0.
- Root Kanban tasks: 0.
- Calendar events: unknown; account connectivity was proven, but a bounded total was not.
- Spotify: 700 saved tracks, 9 playlists, 50 recent items returned.
- Vault: 733 Markdown notes.
- Hermes session store: about 26,000 messages and about 579 MB at final inventory.

Scaling risks:

- Email needs server-side filtering/pagination and a useful priority subset, not a raw unread total.
- Job validation events need indexed/paginated views.
- Session DB growth and WAL size need retention/compaction observability.
- Vault search should be indexed before connecting 733 notes; do not scan the full vault on every keystroke.
- Search correctness for the owner's expected queries remains unknown because no owner-supplied query set was available. FTS row parity in `state.db` was healthy.

### 6D. Desktop-native opportunities

Ranked:

1. Global accessible quick-capture hotkey into Jobs/Progress inbox.
2. Native actionable notifications for job replies, approvals, and urgent incidents only.
3. Screen-reader-friendly tray/menu status showing running commit, connection state, and global stop.
4. File drag/drop and clipboard intake for resumes, job descriptions, screenshots, and OCR.
5. Share-to-Imperator from browser/iPhone rather than a desktop-only island.

Local model: not currently available. Ollama is installed but inactive/disabled, and no model inventory was verified.

Background work worth keeping: gateway connectivity, deterministic sync/indexing, and precomputation for the daily briefing. Healthy/no-op work should stay silent. Do not add another agent or monitor merely to manage these jobs.

### 6E. Proactivity calibration

Daily briefing order:

1. Top three job/income actions.
2. New recruiter/client replies and deadlines.
3. Essential health, housing, or financial action.
4. Only urgent system/security incidents.

Present it once in the morning in Phoenix time or on first open. It is useful only if every item has a next action and deep link. No healthy-system recap.

Good automation candidates:

- Collect and deduplicate fresh job leads.
- Match replies to job records.
- Prepare drafts and application packets without sending.
- Refresh indexes and bounded summaries.
- Silence repeated identical failures with a circuit breaker.

Never auto-promote without approval: external sends, applications, destructive actions, money, credential changes, public exposure, or client-system mutation.

Nagging to avoid:

- Healthy/no-op/success alerts.
- Repeated identical failures.
- Optional homelab/build suggestions while the income gate is closed.
- Multiple reminders for one unresolved item without changed evidence.

Usage adaptation: keep it off by default. Stable ordering matters for screen-reader muscle memory. If added, pin wins, all movement is reversible, and the owner explicitly opts in.

### 6F. Integration wishlist

1. Read-only job-board/recruiter ingestion tied to Jobs/Progress; applications remain manual.
2. Explicit Obsidian read/index integration with curated-write approval and no app-state dumping.
3. Vaultwarden-backed credential brokering so secrets are never copied into prompts or reports.
4. HP Windows voice/STT and accessible desktop handoff.
5. ntfy actionable alerts consolidated with Telegram command context.

### 6G. Trust and privacy

- Global stop must exist on the actual daily runtime, not only the candidate server.
- The active scope should be visible per session.
- Approval integrity must bind to confirmed consent and fail closed for a missing grant before enforce.
- Rate ceilings and outbound secret scanning are useful, but they must not silently broaden autonomy.
- Keep raw credentials, message bodies, and private client details out of audit details.
- Preserve the curated Obsidian boundary: no session dumps, logs, test output, or app databases in the vault.
- Client systems remain audit/report first; mutation requires exact approval.

### 6H. What the brief did not explicitly cover

- **Release provenance is a security and usability control.** The candidate can pass while the owner continues using an older runtime. The dashboard should display backend commit, frontend build commit, data-schema version, and service start time on one System screen.
- **Test isolation is currently part of the product risk.** A focused approval-integrity probe produced a row in the live audit DB. CI and local tests need a mandatory temporary `HERMES_HOME` and a guard that refuses the real home when `PYTEST_CURRENT_TEST` is set.
- **OAuth is model access even when API-key presence is false.** Status screens and handoffs should distinguish key presence from actual provider usability.
