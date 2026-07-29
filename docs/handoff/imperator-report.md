# Imperator on-machine recon report — round 2

**Measurement window:** 2026-07-28 Phoenix time / 2026-07-29 UTC

**Machine:** Marco's live VPS and Dashboard at desktop width `1920×1080`

**Source under test:** fetched `marco/main`, built and served from the isolated `imperator/report-round2` worktree
**Verdict:** the idle Chat fix and motion/text/version fixes are real. The release is not ready for approval-integrity enforcement. Dashboard Chat still fails in live use, Jobs did not finish loading, and a builder-produced declaration without `entity` still produced zero agent tools.

## A. Deployment and release identity

The frontend dependency install and production build succeeded. `hermes-dashboard.service` was repointed to the fetched round-2 worktree, restarted, and repeatedly reached HTTP `302` at the authenticated root.

The Release page showed:

- backend and frontend on the same source revision;
- checkout version `v0.18.2`;
- installed metadata version `v0.19.0`;
- the new **Two installs** warning;
- no backend/frontend commit drift;
- a dirty marker during capture because this report and its screenshots were still uncommitted.

Screenshot: `docs/handoff/screens/round2-release-desktop.png`.

### Why two versions exist

This is not actually a normal wheel-versus-checkout split. The `hermes-agent 0.19.0` distribution is an **editable install** whose `direct_url.json` points at `/home/marco/imperator-workspace/worktrees/hermes-upgrade-stable-0.19`. The PATH entry `~/.local/bin/hermes` resolves to `/home/marco/hermes-agent/venv/bin/hermes`, whose interpreter imports that editable `0.19.0` worktree.

The Dashboard service deliberately sets its working directory and `PYTHONPATH` to the owner-fork round-2 checkout. That checkout declares and imports `0.18.2`. Therefore:

- the owner's `hermes` command runs the editable `0.19.0` upgrade checkout;
- the Dashboard runs the owner-fork checkout at `0.18.2`;
- distribution metadata still says `0.19.0` even when Python imports the Dashboard's `0.18.2` package through `PYTHONPATH`.

### Canonical recommendation

Use **one owner-controlled checkout** as the canonical source, merged onto the accepted `0.19.0` base. Point both the editable venv installation and the Dashboard service at that same checkout. Do not canonize package metadata independently of source.

A blind switch to the current `0.19.0` editable worktree risks dropping owner-main Dashboard changes. A blind switch back to the current `0.18.2` checkout downgrades the CLI/runtime and can lose accepted `0.19.0` behavior. Consolidate by integration and regression testing, not by changing `PYTHONPATH` alone.

## B. Six fixes, measured

### B1. PTY exhaustion

One serialized Chromium context visited Dashboard → Jobs → Capabilities → capability board → Settings → Review without opening Chat.

- Clean baseline: Node 1; Python 2.
- After all chat-free routes: Node 1; Python 2.
- After opening Chat: Node 3; Python 3.

Result: **the idle/chat-free fix passes**. Worker counts did not grow while browsing non-Chat pages.

Chat itself did **not** pass. Opening it added two Node workers and one Python worker, remained on `Installing TUI dependencies…`, and the session endpoint returned `404`. A five-minute browser attempt and a later three-minute attempt never produced a usable assistant turn. Closing the browser did not return the service to the clean baseline before restart.

Screenshots:

- `round2-dashboard-desktop.png`
- `round2-jobs-desktop.png`
- `round2-tasks-board-desktop.png`
- `round2-review-desktop.png`
- `round2-chat-desktop.png`

### B2. Motion

Computed styles were read from real rendered cards under both motion preferences.

- Board card: normal `0.24s` on transform, box-shadow, and background-color; reduced `0s` and none.
- Gallery card: normal `0.3s` on transform, box-shadow, and border-color; reduced `0s` and none.
- Agenda row: normal `0.3s` on opacity, background-color, and border-color; reduced `0s` and none.

Result: **pass**. The Board is on the requested 240 ms move band and all three surfaces correctly collapse to no transition under reduced motion.

Visual judgement: the interactions are subtle and polished rather than flat. Board feels best. Gallery and Agenda at 300 ms are slightly more languid but still restrained; accessibility has not cost visual quality.

Screenshots: `round2-motion-board-desktop.png`, `round2-motion-gallery-desktop.png`, and `round2-motion-agenda-desktop.png`.

### B3. Text floor

Computed font sizes were sampled across Dashboard, Jobs, Capabilities, Board, System, and Review. Every route had a minimum rendered size of **12 px**. No below-floor selectors were found.

Result: **pass**.

### B4. Approval integrity

A real `hermes -z` agent turn on the owner's configured `gpt-5.6-sol` / OpenAI Codex route executed bounded work through the actual model-tool boundary. The audit ledger recorded six post-middleware grants:

1. `skill_view`
2. `terminal`
3. `write_file`
4. `imperator_run_control`
5. `cronjob`
6. `skill_manage`

Denominator: **6 verified / 6 attempted; 0 refusals; 0 false positives**.

This proves the post-middleware digest fix for the tested families. It does **not** satisfy §C's family-complete denominator. The live agent tool surface did not expose direct email-send, calendar-write, or capability-author tools. The capability browser write was an HTTP/UI action, not an audited model-tool grant. Exact family coverage is therefore only **3 of 6 required classes**: file write, terminal, and skill install. No external email was sent and no calendar event was created.

Recommendation: **leave `approval_integrity` in `observe`**. The available 6/6 sample is clean, but the mandated email, calendar, and capability families remain unmeasured. No enforcement setting was changed.

All temporary files, the smoke-test skill, scheduled job, and seeded capability entities/declaration were removed. The test run-control record was closed as completed; audit records were retained as proof.

### B5. Version identity

Result: **pass**. The Release page correctly names running `0.18.2`, installed `0.19.0`, and the two-install condition. The backend and frontend build revisions matched.

### B6. Capability tool generation without `entity`

The builder authored, reviewed, and applied a schema-valid declaration with no `entity` key. The capability appeared and its records rendered in Board, Gallery, and Agenda.

Tool generation result: **fail**. `_entity_of()` correctly fell back from missing `entity` to the declaration ID, so the old `KeyError` is fixed. However, the builder-produced declaration had no `agent.expose` section. Passing the emitted declaration to `build_tools()` returned an empty list. The builder therefore produced a valid capability with working UI storage but **zero agent tools**.

This is a different failure from round 1 and should be fixed in the builder/template contract: either emit sensible `agent.expose` defaults, make tool exposure an explicit required builder step, or state plainly that the created capability is UI-only.

Screenshots: `round2-capability-builder-desktop.png`, `round2-capability-review.png`, and `round2-capability-no-entity-declaration.png`.

## C. Approval-integrity enforcement decision

- Verified grants: **6**
- Refusals: **0**
- False positives: **0**
- Required gated classes exercised: **3/6**
- Missing classes: direct email send, calendar write, capability write
- Decision: **remain in observe mode**

The result is encouraging but not family-complete. Enforcing on a partial denominator would violate the work order's fail-closed rule.

## D. Desktop layout judgement

### Jobs

At `1920×1080`, the page shell appeared, but its content stayed on **Loading jobs…** for more than 90 seconds. That is a functional failure, not just a density problem, and prevented a truthful judgement of the fully populated current layout.

The hierarchy I would ship once loading works:

1. Lead with one sentence and one action: **“Apply to [best fresh job] now”**, with age, fit, packet status, and application link.
2. Keep only the best five actionable leads in compact rows above the fold.
3. Collapse counters, quotas, and secondary pipeline statistics behind **Pipeline details**.
4. Move filters below the primary action and persist them rather than making them the first task.
5. Delete duplicate counters and quota bars from the first screen; they describe the system rather than help Marco act.

Screenshot: `round2-jobs-loaded-desktop.png` records the unresolved loading state.

### Gallery

At desktop width the Gallery uses two very wide sparse cards and leaves most of the lower page empty. Card sizing and column count could be tightened, but the deeper problem is the default view: these records are state/action oriented, so Board or compact List is more useful. Gallery should be optional, use three narrower columns at this width, and reserve large cards for image-rich capabilities.

Screenshot: `round2-gallery-loaded-desktop.png`.

### Agenda

Agenda is visually stronger: dates and undated items are separated, the hierarchy is readable, and the compact rows use space well. It is suitable when a capability genuinely has dates, but it should not be the default for undated operational records.

Screenshot: `round2-agenda-loaded-desktop.png`.

## E. Smart-approval reasoning gap

Ship **option 2: change the card**.

`_smart_approve()` asks the guard model for exactly one token-class verdict—`APPROVE`, `DENY`, or `ESCALATE`—with `max_tokens=16`, then reduces it to a string. No reason exists in the protocol. The current Chat card renders the event's available text and decision buttons; it cannot truthfully display model reasoning that was never produced.

Option 1 adds tokens and latency to every guarded call and still produces a model explanation, not proof that the action is safe. Option 3 is worse: a locally reconstructed rationale would look authoritative while being synthetic. Show only verified facts: tool, redacted arguments/command, trigger, risk tier, scope, permanence, and exact decision options. If a model verdict influenced routing, label the verdict as such without inventing a rationale.

## F. Requested judgement

1. **Was documenting the gold rule instead of sweeping 97 sites right?** Yes. A blind global replacement would trade one inconsistency for many context-free ones. Enforce the three-use rule on new and touched surfaces, add lint or review checks where practical, and let the back catalogue converge deliberately.

2. **Single worst remaining thing:** Dashboard Chat. The idle worker leak is fixed, but the actual Chat path still fails to become usable, installs dependencies at runtime, returns a missing session, and leaves workers behind. A core surface cannot depend on this fragile PTY bootstrap.

3. **What will the owner probably never use?** Gallery as the default capability view in its current sparse, decorative form. Marco's real work is status- and action-driven; Board/List and direct actions fit it better. Keep Gallery only for genuinely visual datasets.

4. **What is missing from a personal intelligence hub?** A reliable, income-first **Now** surface backed by a real volatile-context tool: current mission, best next action, deadline/reply exceptions, last proof, blocker, and approval state in one place. The architecture names `hub_context`, but the implementation/affordance is absent.

## G. Seven owner questions

### G1. Which install should be canonical?

The canonical artifact should be one owner-controlled checkout integrated onto `0.19.0`, with the venv editable install and Dashboard service pointing to the same root. The present “wheel” is actually editable metadata for a separate worktree. Standardizing blindly on either current root loses something: owner Dashboard changes on one side or accepted 0.19 runtime behavior on the other. Integrate first, then repoint both.

### G2. Real usage shape

Thirty-day session evidence shows interactive use is messaging-first: 33 Telegram sessions, 12 CLI sessions, and 10 TUI sessions. Automated cron and subagent sessions are much more numerous but are not owner page usage. Tool use is dominated by terminal, file reads/searches, patching, and skills. The owner uses Imperator primarily as an operational agent, not as a passive visual database.

The Dashboard has no durable page-view telemetry, so exact “opened/never opened” claims would be fabricated. Current workflow evidence supports Jobs/Progress, Sessions/Chat, Review/approvals, and System status as high-value surfaces. There is little evidence of routine use for Graph/Entities, Learning, Gallery, MCP administration, or the native Email/Calendar pages. Do not add behavioral telemetry merely to answer this; simplify around the known income and action flows.

### G3. Does the agent call `hub_context`?

No. The state database contains **zero `hub_context` tool calls in both the last 7 and 30 days**, and the source search finds the name only in architecture/work-order documentation. It is not a registered live tool. The architecture may be right, but this is not an affordance problem yet—the implementation is missing.

### G4. Where is latency?

- Normal route shells appeared in roughly **50–250 ms** after subtracting the harness's fixed 1.2-second settle delay.
- Capability builder review/apply was about **1.1 seconds**.
- Jobs content did not finish loading in **90 seconds**.
- Dashboard Chat did not become usable in **five minutes** on the first live attempt or **three minutes** on the second.
- Card transitions are 240–300 ms and feel intentional rather than slow.

The two material latency defects are Jobs data readiness and Chat/TUI startup, not base navigation.

### G5. Gmail and Calendar cadence

Gmail polls only while its tab is visible. It checks the cheap profile `historyId` immediately and then every **45 seconds**; when the ID advances it fetches the history delta and offers a non-disruptive refresh. Expected detection staleness is up to about 45 seconds, plus any delay before the user accepts the refresh.

Calendar has **no interval polling**. It fetches connection/events/tasks on page load, refreshes manually, and mutates after local writes. An already-open Calendar tab can remain stale indefinitely for external changes.

Whether Marco notices this staleness is **unknown**: no direct complaint or usage telemetry proves it. The implementation cadence is clear; owner impact is not.

### G6. Native voice

Infrastructure is healthy but end-to-end native voice is **not proven**. The HP voice bridge returned HTTP 200, the Whisper/STT edge port was reachable, and the relevant VPS services were active. I found no verified run covering microphone input → transcription → Hermes turn → spoken response through the Dashboard/native client. Report this as configured/reachable, not as exercised and working.

### G7. What would I build next?

Fix the existing Jobs page first: bounded API latency, explicit error/empty states, and one fresh manual-application action above the fold. It directly serves the income gate and is smaller than the deferred native Chat replacement. The next reliability item after that is the current PTY Chat bootstrap and worker teardown—not a new dashboard or tracker.

## Validation and cleanup

Verification completed:

- Frontend tests: **332 passed**.
- Frontend typecheck: passed.
- Frontend lint: passed.
- Focused approval/capability/module backend tests: **56 passed**.
- Production frontend build: passed.
- Focused health test set: 11 passed, 1 failed. The failure is environment-sensitive: `test_provenance_no_distribution` expects no installed distribution, but this machine intentionally has editable `hermes-agent 0.19.0` metadata. This is a test-isolation defect, not a demonstrated runtime failure; the live Release page correctly reported both identities.

Temporary test files, cron entry, skill, capability declaration, and capability entities were removed. No email, calendar event, public message, credential, or external account was changed.

## Final decision

Round 2 confirms meaningful fixes, but it also exposes three blockers:

1. Chat-free browsing is bounded, but opening Chat is still broken and leaks workers.
2. Approval-integrity evidence is clean but only covers 3/6 required gated classes; remain in observe.
3. Builder declarations without `entity` no longer crash, but the emitted declaration generates no tools because `agent.expose` is absent.

Jobs loading is also a direct income-flow defect and should be repaired before optional visual expansion.
