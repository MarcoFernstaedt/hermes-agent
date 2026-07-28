# Imperator on-machine report — 2026-07-28

Source under review: `marco/main` at `5ca9f1795c5a0930285df2ab9900b3d79cd29000`.

## Lead decisions

### 1. Deploy: current and no visible drift

**Result:** port `9119` is now served from the report worktree at the authoritative `marco/main` source commit. The frontend was rebuilt from the same commit. Settings → System → Release showed backend and frontend at `5ca9f1795`; the drift banner was absent.

Before:

- Service unit: `~/.config/systemd/user/hermes-dashboard.service`.
- Working directory: `/home/marco/imperator-workspace/worktrees/hermes-upgrade-stable-0.19`.
- Checkout commit: `d1cbc59c7c535d343450b296f8afcd4d585f8813` on `upgrade/hermes-0.19-stable-imperator`.

After:

- Working directory: `/home/marco/imperator-workspace/worktrees/hermes-report-2`.
- Backend source and served frontend: `5ca9f1795c5a0930285df2ab9900b3d79cd29000` on `imperator/report-2`.
- `build-info.json`: commit `5ca9f1795`, branch `imperator/report-2`, dirty `false`, built `2026-07-28T19:29:36.386Z`.
- Service restart returned active; HTTP `/` returned `200`.

Commands used:

```text
git fetch --all --prune
npm install
npm run build
systemctl --user daemon-reload
systemctl --user restart hermes-dashboard.service
systemctl --user is-active hermes-dashboard.service
curl --fail --silent --show-error http://100.119.218.113:9119/
```

Evidence: `screens/release-no-drift.png`.

One version inconsistency remains: the live sidebar displayed `v0.18.2`, while the installed Hermes CLI reports `Hermes Agent v0.19.0 (2026.7.20)`. The Release source hashes match, so this is stale or separately sourced product-version presentation, not frontend/backend source drift.

### 2. Approval integrity: DO NOT ENFORCE

**Recommendation: stay on observe.**

Live audit counts from `~/.hermes/audit_log.db`:

- `payload_changed_after_approval / blocked`: 1.
- `verified / ok`: 1.

The blocked row was for `terminal` and recorded expected and actual argument hashes that differed. Values were not exposed. This is precisely the mismatch class enforcement would block. A single successful verified call is also not the representative denominator requested by the work order.

The implementation has the right primitives: one-shot call IDs, canonical argument hashing, replay rejection, explicit mismatch audit rows, and a fail-closed enforcement path. The live evidence does not justify changing modes. Close the legitimate middleware-mutation path, then gather several clean `verified` rows across file write, terminal, and another configured gated tool before reconsidering enforcement.

### 3. Protocols: Hermes 0.19.0; 128 methods and 34 events

Installed CLI:

```text
Hermes Agent v0.19.0 (2026.7.20)
upstream 89490ae3
local d1cbc59c (+69 carried commits)
Python 3.11.15
```

The deployed TUI gateway is JSON-RPC 2.0:

- Request: `{jsonrpc:"2.0", id, method, params}`.
- Success: `{jsonrpc:"2.0", id, result}`.
- Error: `{jsonrpc:"2.0", id, error:{code,message}}`.
- Event: `{jsonrpc:"2.0", method:"event", params:{type,session_id,event_id,payload?}}`.

I extracted and manually checked **128 registered methods** and **34 emitted event types** from deployed `tui_gateway/server.py`. The complete names, parameter-key unions, result-key unions, payload shapes, and source lines are in `protocol-catalogue.generated.md`.

Smart-approval verdict limitation:

- `approval.request` carries the redacted `command`, `pattern_key`, `pattern_keys`, `description`, and `allow_permanent`.
- It does **not** carry an LLM smart-approval verdict or reasoning.
- `_smart_approve()` asks the auxiliary model for exactly one word and reduces it to `approve`, `deny`, or `escalate`; reasoning is neither requested nor retained.
- Auto-approved and auto-denied decisions do not produce a manual `approval.request`. Only escalation falls through to that event.

The native structured client therefore cannot design a “reviewer judgement + reasoning” card against the current protocol. That data does not exist elsewhere in a durable form.

Plugin contract in this version:

- `PluginContext.register_tool(name, toolset, schema, handler, check_fn=None, requires_env=None, is_async=False, description="", emoji="", override=False)`.
- `register_cli_command(name, help, setup_fn, handler_fn=None, description="")`.
- `register_command(name, handler, description="", args_hint="")` for in-session slash commands.
- Typed provider registrations cover context engine, image/video generation, dashboard authentication, web search, browser, secret sources, TTS, transcription, and platforms.
- Additional contracts cover Slack action handlers, auxiliary LLM tasks, hooks, middleware, and read-only plugin skills.
- Dashboard tabs remain manifest-driven. The server scans `~/.hermes/plugins/<name>/dashboard/manifest.json` first, then bundled `plugins/<name>/dashboard/manifest.json`.

### 4. Worst finding: Dashboard chat lifecycle can exhaust itself

The worst operational defect is not cosmetic. The Dashboard can accumulate detached TUI/PTY chat processes until it churns on reconnects and interferes with unrelated UI testing.

Live diagnosis before recovery:

- 16 Node TUI processes and 15 Python `slash_worker` processes.
- The workers were idle on `pipe_read`, not making report progress.
- Dashboard memory was approximately 2.38 GB with 291 tasks.
- The registry retains disconnected sessions for 30 minutes and caps them at 16.
- Every fresh browser context received a fresh attach identity because Chat is mounted while visiting other routes.
- Logs repeated WebSocket disconnect exceptions and `Installing TUI dependencies…`.

A service restart cleared the retained workers. The preventive rule is now recorded in the agent-session observability procedure: one persistent browser context, preflight worker count, explicit teardown, a hard stop before 16 retained sessions, and no blind rerun after an interrupted side-effecting test.

The product fix should be: mount/start Chat only when needed, reuse a stable attach identity, explicitly close automation sessions, avoid reinstalling TUI dependencies per attach, and expose retained-session count plus a safe cleanup control.

## A. Deployment details

The service was repointed rather than force-updating the old worktree. A rollback copy of the prior unit and its SHA-256 is retained under `/home/marco/imperator-workspace/rollback/imperator-report-2-20260728/`. No force-push or destructive Git operation was used.

Fresh evidence was captured after moving eight pre-existing screenshots out of the report evidence directory.

## B. Verification of shipped behavior

### B1. Global stop — PASS

- Sidebar stop engaged the red `Agent halted` state.
- Reload preserved the halted state server-side.
- A harmless marker tool dispatch was refused with: `Agent halted — all tool activity is paused by the global stop.`
- Release restored the server and UI state.

Evidence: `/home/marco/imperator-workspace/artifacts/report2-global-stop.json`.

### B2. Session scope — PASS

- The tested session persisted `Read-only` as server scope `read_only`.
- A harmless write marker was refused by dispatch, not merely hidden.
- The session was restored to `Full`; final server scope was `full`.

Evidence: `/home/marco/imperator-workspace/artifacts/report2-session-scope.json`.

### B3. Review queue — PASS

The route rendered. The exact-action disclosure was opened. An agent-authored governed proposal was visible and reviewable. Existing rejected/expired records remain as useful audit history.

Evidence: `screens/review-agent-authored-expanded.png` and `/home/marco/imperator-workspace/artifacts/report2-agent-proposal-review.json`.

### B4. Capability builder — PASS, cleanup complete

Two template-based throwaway capabilities were exercised during the investigation. The final Content flow included Gallery and an `Agenda by` date field. A deliberately invalid slug produced a live validation error and disabled proposal; correction cleared the issue. The proposal was approved and its `/c/<id>` surface was usable.

Cleanup:

- Removed both throwaway declaration JSON files.
- Removed four associated test records from `entities` and `entities_fts`.
- Entity database FTS integrity and SQLite `quick_check` both returned `ok`.
- Proposal rows were retained as review audit history rather than deleting ledger evidence.

Evidence: `screens/capability-content-template-configured.png`, `screens/capability-content-validation-error.png`, `screens/capability-content-declaration.png`, and `report2-capability-continue.json`.

### B5. Four view kinds — PASS with an automation caveat

Board, Table, Gallery, and Agenda all rendered the three seeded records. Fresh screenshots show the expected surface changes. Agenda visibly included the date grouping and preserved an undated record under `No date`; selector-based counters in the automation artifact did not reliably identify those headings, so the screenshots—not those zero counters—are the evidence.

Evidence:

- `screens/capability-content-board.png`
- `screens/capability-content-table.png`
- `screens/capability-content-gallery.png`
- `screens/capability-content-agenda.png`

### B6. Motion — PARTIAL / NOT PROVEN AS DESIGNED

- A valid Board move completed.
- An invalid transition was denied.
- The record was restored.
- Reduced-motion mode was detected and reduced transition/animation durations to effectively zero.

However, the inspected card already reported `transitionDuration: 0s` and `animationDuration: 0s` before reduced-motion was enabled. I therefore cannot claim that normal arrival, travel, or warm-gold live-update motion looked good. Reduced-motion suppression passed; the intended normal motion remains unproven and may be absent on the inspected path.

Evidence: `/home/marco/imperator-workspace/artifacts/report2-board-drag-motion.json`.

### B7. Jobs “Today — ready to apply” — PARTIAL

The live surface showed three real packet-ready roles and the expected `Open application` and `Mark applied` controls. Pipeline counts were 258 total, 108 packet-ready/not applied, and 29 expired/closed. I did not mark a real role applied because that would create a false application state. No safe throwaway job was available. The controls rendered, but end-to-end mutation was not claimed.

Evidence: `screens/jobs-live.png`.

### B8. Spotify — DISCONNECTED

Live authentication status returned `logged_in: false`. A read attempt failed with `Spotify is not authenticated. Run hermes auth spotify first.` No reconnect was attempted because OAuth requires the owner’s Spotify interaction. The token is not healthy.

### B9. Chat — FAIL / reliability defect reproduced

The controlled two-client run did not establish a reliable second-client transcript. It timed out waiting for the marker in the second client, and the artifact recorded zero matched user/assistant markers. Screenshots were captured, but they do not override the failed assertion.

The same test campaign exposed the retained-session/reconnect defect described in the lead finding. I cannot honestly certify send/stream/approve or “no duplicate response” across two clients from this run.

Evidence: `screens/chat-first-client.png`, `screens/chat-second-client.png`, and `/home/marco/imperator-workspace/artifacts/report2-chat-e2e.json`.

## C. Decisions

### C1. Approval integrity

Stay on observe. See the lead decision. Required closure before enforcement:

1. Identify the legitimate argument mutation that produced the live hash mismatch.
2. Hash the effective post-middleware payload at one canonical boundary.
3. Add stale, replay, mismatch, and successful end-to-end gateway tests.
4. Gather a representative live denominator across multiple gated tool families.

### C2. Hermes and gateway protocol

See the lead protocol decision and `protocol-catalogue.generated.md`.

### C3. Guardrail calibration

Current policy:

- Rate ceilings: observe by default.
- Outbound secret scan: enforce.
- Default ceilings: writes 400/hour, sends 40/hour, deletes 60/hour.

Live `agent_guards` audit rows: **0**. Therefore there is no empirical production false-positive rate, and no observed `outbound_secret_detected` event can be classified as a false alarm.

Judgement:

- 400 writes/hour is permissive enough for ordinary development and content workflows.
- 40 sends/hour is appropriately conservative for reputation-sensitive messaging.
- 60 deletes/hour is generous; keep deletion independently approval-gated regardless of the rate ceiling.
- Keep rates in observe until real incidents exist. Keep outbound secret scanning in enforce.

Focused backend tests passed for approval integrity, agent guards, scope, review queue, global stop, and capability schema. One capability module test failed: a scaffolded capability without an `entity` section caused generated tool discovery to raise `TypeError: 'NoneType' object is not subscriptable`. This is a real default/scaffold robustness defect and should be fixed before treating arbitrary scaffolded modules as safe.

Focused frontend tests: 129 passed across capability model/builder, Chat, Jobs, Plugins, and Settings suites.

## D. Accessibility

### What is complete

- Keyboard and semantic browser checks exercised the main shell and report surfaces during automation.
- Fresh screenshots were inspected for visible hierarchy, density, contrast, clipping, and control discoverability.
- Reduced-motion mode was directly exercised.
- The HP Windows workstation is reachable.
- NVDA `2026.1.1` and Chrome `150.0.7871.182` are installed.
- Firefox was missing; I installed Firefox `153.0.1` successfully so the requested cross-browser manual pass is now possible.

### What is not complete

**No genuine NVDA pass is claimed.** NVDA was not running on the interactive Windows desktop, and remote SSH/browser automation cannot prove what NVDA speaks, whether browse/focus mode changes correctly, or whether live regions spam or go silent. VoiceOver is unavailable on the Windows/Linux fleet.

The remaining human acceptance pass must be done on the HP with NVDA running, separately in Chrome and Firefox:

1. Open the live Dashboard URL and sign in.
2. For the shell, `/review`, `/capabilities/new`, Board, Table, Gallery, Agenda, and Chat, use `H`/`Shift+H` to traverse headings and `Tab`/`Shift+Tab` for controls.
3. Toggle NVDA browse/focus mode with `NVDA+Space` where editing or drag controls require it.
4. On Agenda, verify heading navigation moves date by date, including `Today` and `No date`.
5. Submit one harmless Chat message and confirm streaming/live-region announcements are meaningful and not repeated.
6. Record any trap, silence, misleading label, duplicate announcement, or focus loss per browser.

This is the only remaining user-executed acceptance item; the browsers and NVDA are installed.

## E. Judgement

### Three worst flows and shorter paths

1. **Chat attach/reconnect lifecycle.** Current path silently mounts Chat, creates identities, retains workers for 30 minutes, then churns. Shorter path: one stable client identity, lazy Chat startup, explicit disconnect cleanup, and a visible retained-session counter.
2. **Capability creation.** Builder → propose → Review → inspect → approve → find `/c/<id>` is governance-correct but fragmented. Shorter path: after proposal, open the exact Review record automatically; after approval, present one `Open capability` action and cleanup guidance for tests.
3. **Jobs application.** The page stacks Today rows, nine pipeline counters, two quota bars, filters, and full cards before the user acts. Shorter path: make Today the primary task list with one `Review application` action, then expose pipeline analytics on demand. Preserve manual submission.

### Work still outside Imperator

- Real job application submission remains manual by policy and should stay that way.
- Genuine NVDA acceptance is still a Windows interactive task.
- Spotify OAuth reconnect is still an owner browser interaction.
- Low-level service/repository recovery still required raw shell and systemd rather than a reliable operator tool.

### Dead surfaces

There is no trustworthy route-open telemetry in this recon, so I will not label a surface dead from guesswork. The Plugins page was captured in a persistent `Loading…` state, and Spotify is disconnected, making both low-value in their current state. Instrument route opens and successful actions before proposing retirement.

### Tool ergonomics

- `imperator_dashboard_feed` failed with `fatal: Needed a single revision`; it did not produce a recoverable repo identifier.
- The Todo store returned zero items after context compaction even though the work checklist survived in conversation context.
- Delegation failed closed because SQLite 3.50.4 could not safely transition `~/.hermes/state.db` from WAL to DELETE. The safety behavior is correct, but it removed the independent-review path.
- Browser automation had no bounded “close all test clients” operation and amplified Dashboard PTY retention.
- Capability cleanup required direct SQLite work because no typed delete/cleanup tool existed.
- The Spotify handler constructs its client before its exception wrapper, so unauthenticated direct invocation emitted a traceback instead of only a structured tool error.

### Data realities

Observed live scale:

- Jobs: 258 total; 108 packet-ready/not applied; 29 expired/closed; 3 in Today.
- Profiles: 10.
- Plugin API: 85 plugin records; 2 dashboard extension manifests.
- Test capability: 3 seeded records across four views before cleanup.
- Approval-integrity audit: 2 relevant rows.
- Agent-guard audit: 0 rows.

Jobs is the clearest density/volume risk: rendering a large packet-ready list under heavy summary chrome will become slower to scan long before 258 records becomes a database problem. Chat’s retained-process behavior is already a runtime scale problem at only 16 detached clients.

### Does it look good?

**It looks coherent and distinctive, but not yet expensive or calm.**

What works:

- Obsidian/gold identity is consistent.
- Major headings and key counts are legible.
- Content cards and status groups have a clear visual grammar.
- The dark theme suits the owner’s low-vision preference better than a bright default.

What does not:

- Gold is used for almost every label, nav item, border, and action, so it no longer indicates the one thing that matters.
- Many controls and secondary labels are small and low-contrast.
- The left navigation is very long and visually dominant.
- Jobs is crowded and repeats information between Today, pipeline counts, and cards.
- Capability Gallery has large empty columns and sparse cards, making the screen feel unfinished rather than deliberately spacious.
- Plugins sitting at `Loading…` reads as broken.
- Normal caused motion was not proven; on the inspected card it appeared absent.
- The sidebar’s `v0.18.2` conflicts with the actual installed Hermes 0.19.0.

The design is past “cheap prototype,” but it needs stricter emphasis, larger accessible secondary text, fewer simultaneously visible modules, and reliable motion/loading states to feel polished.

### Additional issue that matters

The Dashboard’s product/runtime identity is split: source provenance says current, the installed CLI says 0.19.0, and the sidebar says 0.18.2. Release provenance and marketing/product version should come from one authoritative runtime source.

## Final status

- Deployment: complete.
- Sections B and C: complete with explicit PASS/PARTIAL/FAIL outcomes.
- Throwaway capability cleanup: complete and database-verified.
- Protocol catalogue: complete and source-checked.
- Approval recommendation: stay on observe.
- Genuine NVDA Chrome/Firefox acceptance: prepared but human-gated; not fabricated.
- Git publication and exact remote verification are recorded in the delivery message, not self-referenced inside this report.
