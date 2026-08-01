# Imperator dashboard — release evidence

Written for review, not for reassurance. The unproven items are listed as
prominently as the proven ones, because the failure mode this project keeps
hitting is a green test suite that agreed with the code and was wrong with it.

## Candidate

- Branch: `claude/imperator-dashboard-mobile-xw09ri`, merged to `main`
- Baseline: `fab8f79c9` ("Phase 4: the approve / deny / modify card")

**Packaged build provenance.** `hermes_cli/web_dist/` is gitignored — the
packaged frontend is a build artifact, not a committed tree, so its provenance
is produced and checked at build time rather than reviewed in the diff.
Verified here by building from a clean checkout of the candidate:

```json
{
  "commit": "6a61c07254c6e4de4895d093e7f3886527301cd1",
  "commit_short": "6a61c0725",
  "branch": "claude/imperator-dashboard-mobile-xw09ri",
  "dirty": false
}
```

Reproduce with `cd web && npm run build && cat ../hermes_cli/web_dist/build-info.json`
on a clean tree; `dirty: false` and a matching `commit` is the check.

## What this candidate contains

### Delivered and tested

**Accessible shell (Phase 2).** A skip-to-main link — the first focusable
element in DOM order, hidden off-screen rather than removed from the tab order
— and a single `<main id="main-content" tabIndex={-1}>` landmark. Neither
existed in the audited release. `auditPageShell()` extends the existing a11y
gate with `skip-link`, `main-landmark` and `single-h1` rules, and fails on a
skip link that comes *after* the navigation it should skip.

**Now reading order (Phase 2).** `web/src/lib/nowOrder.ts` defines the order as
data so it can be asserted rather than implied by JSX nesting: heading →
outcome → gate → commitment → application → exception → ask → links. Sections
with nothing to say are absent rather than empty, exceptions appear only when
action is required, and applications appear only when Marco entered one.

**Capability status contract (Phase 3).** `hermes_cli/capability_status.py` and
`capability_adapters.py`, behind `GET /api/system/capabilities`. Six
independent signals — supported, configured, credential, reachable,
authenticated, proven — with `state` derived in a fixed precedence. The Home
Assistant case from the live audit is the worked example and a test: container
running, root 200, `HASS_URL` set, no token ⇒ `no_credential`, not
`unreachable` and not `operational`. `None` means "we did not look" and is
reported as unproven, never as fine. Stripe, Plaid and Twilio report
`Not connected` with one safe next action and carry no numeric field a balance
could be invented into.

**Google auth diagnostic and provisioning.**
`python -m hermes_cli.google_auth_status status|provision`. Distinguishes
`not_connected` / `incomplete` / `reauth_required` / `unreadable` / `usable`,
because an undecryptable store is a key problem, not a permission problem, and
reporting it as "not connected" sends the owner to re-authorise a grant that is
fine. Exits non-zero when unusable so it composes with `&&`.

**ALWAYS_APPROVAL enforced.** Tracing why `build_approval_preview()` had no
caller found that `module_permissions.resolve()` had no production callers
either — the tier was recorded and nothing enforced it. `gmail_send` now blocks
on the approval gate with the message on the card, keyed on the message
fingerprint, `once_only` (no session cache, no `--yolo`, no
`cron_mode: approve`, nothing persisted).

**Security headers (Phase 5).** CSP, HSTS gated on a genuinely secure request
(reading `X-Forwarded-Proto`, because Tailscale Serve terminates TLS), frame
protection, referrer policy, permissions policy, nosniff. `connect-src` allows
`ws:`/`wss:` — omitting it does not fail loudly, chat simply never connects.
`/api/ws` is excluded entirely.

**Undo, idempotency, native chat transport.** Carried from the prior review
cycles; see the merge commit.

### Not delivered in this candidate

**Voice push-to-talk (Phase 4) is not implemented.** The capability *status*
for it is (it reports whether `faster_whisper` and `edge-tts` are installed,
and never claims the microphone-to-speaker path is proven), but the browser
`MediaRecorder` capture, the protected transcription endpoint, the state
machine and the transcript controls are not built. Do not read the green
capability card as a working feature.

**Camera assistance (Phase 4) is not implemented.** Same position: the status
adapter exists and correctly reports it as session-bound and unproven; the
`getUserMedia` flow, the active indicator, the single Stop control and the
one-frame capture path are not built.

**The Now page has not been recomposed against `nowOrder.ts`.** The module and
its tests exist; `NowPage.tsx` still renders its earlier composition. The
ordering contract is therefore asserted but not yet enforced on the rendered
page.

**No capability card UI.** The endpoint returns the contract; no component
renders it yet.

## Verification

Run from the candidate:

```
cd web && npm run typecheck && npx eslint src && npx vitest run && npm run build
```

| Check | Result |
|---|---|
| `npm run typecheck` | exit 0 (resolves `tsconfig.app.json`; the repo's old `tsc -p .` checked nothing) |
| `npx eslint src` | 0 errors, 0 warnings |
| `npx vitest run` | **71 files, 624 tests passed** (baseline was 66 / 526) |
| `npm run build` | succeeded |

Python, focused on what this candidate touches:

```
HERMES_TEST_PATHS="tests/hermes_cli/test_capability_status.py:tests/hermes_cli/test_security_headers.py:tests/hermes_cli/test_security_headers_wiring.py:tests/hermes_cli/test_google_auth_diagnostic.py:tests/hermes_cli/test_undo_journal.py:tests/hermes_cli/test_action_substrate.py:tests/tools/test_gmail_send.py:tests/tools/test_request_tool_approval.py" \
  HERMES_TEST_WORKERS=6 python scripts/run_tests_parallel.py -q
```

The brief's named auth/dashboard suites:

```
HERMES_TEST_PATHS="tests/hermes_cli/test_dashboard_auth_password_login.py:tests/hermes_cli/test_dashboard_auth_middleware.py:tests/hermes_cli/test_dashboard_unified_launch.py:tests/hermes_cli/test_dashboard_media.py:tests/plugins/test_plugin_dashboard_auth_contract.py:tests/hermes_cli/test_life_progress.py" \
  HERMES_TEST_WORKERS=6 python scripts/run_tests_parallel.py -q
```

→ **6 files, 142 tests passed, 0 failed.** This is the check that matters most
for the new outermost middleware.

### Pre-existing failures, attributed

`tests/tools`: 8498 passed, 19 failed. `tests/hermes_cli`: 9789 passed, 21
failed. **All pre-existing and environmental** — ssh binaries, ripgrep, man
pages, systemd, network. Verified by re-running the failing files with this
work stashed and getting identical failures in both directions. No test was
deleted or weakened to obtain green.

## A defect this work found in itself

The security-headers middleware was first registered near the other header
middleware, which put it *inside* the auth gates. Every short-circuited 401 came
back with no `nosniff` and no referrer policy — the responses most worth
protecting were the only unprotected ones. Moving it to be registered last
(hence outermost) fixed it, and
`test_a_rejected_request_is_protected_too` pins it.

## Integration state matrix

No secret value appears here or in the endpoint. Presence only.

| Capability | State | Next action |
|---|---|---|
| Google Workspace | per `google_auth_status` | provision, or reconnect |
| Home Assistant | `no_credential` (URL set, no token) | create a long-lived token, set `HASS_TOKEN` |
| Voice | `unproven` (both halves installed) | run push-to-talk acceptance — **not built yet** |
| Stripe | `not_configured` | add a restricted read-only key when wanted |
| Plaid | `not_configured` | connect via Plaid's own consent flow when wanted |
| Phone (Twilio) | `not_configured` | connect when a number is wanted |
| Camera | `unproven` (browser-owned) | **not built yet** |
| Location | `unproven` (browser-owned) | **not built yet** |

## Accessibility: automated vs manual

Automated: skip link target/order/focusability, one `main`, one `h1`,
interactive-element naming, image alt, Now reading order, reduced-motion class,
visible focus ring.

**Manual NVDA checks, not performed here** — this container has no screen
reader:

1. Tab from page load: the skip link is first, announced, and moves focus (not
   just scroll) into `main`.
2. `M` jumps to the main landmark on every route.
3. `H` walks a sensible heading tree; exactly one `h1`.
4. Reading order matches visual order on Now, Chat, Jobs, Progress, Settings.
5. Approval card: consequence read before any button; Approve/Deny reachable
   and named; resolution announced once, not repeatedly.
6. Live regions announce only consequential changes — no log, timer, token
   stream or health poll is read continuously.
7. Forms name the field and the recovery action on error, without relying on
   colour.
8. Dialogs: accessible name, initial focus, containment, Escape, restoration.

## Physical-device checks, not performed here

- Microphone → STT → Hermes → TTS → speaker, on HP and on iPhone.
- Camera permission, active indicator and Stop, on a real device.
- Home Assistant authenticated read, once a token exists.
- A real Gmail send through the approval card.

`docs/plans/imperator-live-acceptance.md` is the procedure, with the counts to
record.

## Deployment — dry run only

Nothing was deployed. The live service continues to run from
`worktrees/hermes-owner-main-release-fab8` at `fab8f79c9`, untouched.

A deployment would be: fetch, check out the candidate in the release worktree,
verify `build-info.json` matches and `dirty: false`, restart the service.
**That is a description, not an instruction, and it is Imperator Prime's call.**

## Rollback

```
git checkout main && git revert -m 1 <merge-commit>
```

The merge is a single commit; reverting it restores `fab8f79c9`'s tree. No
migration ran, no schema changed destructively (the undo journal adds a nullable
column via `ALTER TABLE`, which an older build ignores), and no external state
was mutated.

## Explicit statement

No deployment, no service restart, no account connection, no message sent, no
payment, no home control, and no public exposure occurred. `/home/marco/.hermes`
was not touched — this work ran in an isolated container at
`/home/user/hermes-agent`.
