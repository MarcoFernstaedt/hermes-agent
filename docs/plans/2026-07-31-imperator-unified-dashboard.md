# Imperator unified dashboard — implementation plan

One dashboard, one identity, one source of daily focus. This plan records what
is being reused, what is being added, and — more usefully — what is deliberately
*not* being built, because the failure mode this brief is guarding against is a
second version of something that already exists.

## What already exists and is being reused, not rebuilt

| Need | Existing surface | Decision |
|---|---|---|
| Daily focus / outcome / routines / income gate | `hermes_cli/life/router.py`, `hermes_cli/life/repository.py`, `web/src/pages/ProgressPage.tsx` | **Reuse.** Now projects Progress state. No second store. |
| Approve / deny / modify | Phase 4 approval card, `tools/approval.py`, `write-approval-flow.ts` | **Reuse.** No second approval path. |
| Chat session and transport | `tui_gateway` over `/api/ws`, `useNativeChat`, `ChatPage` | **Reuse.** Ask Imperator opens the same session. |
| Calendar / Email | existing protected Google routes + `hermes_cli/google/*` | **Reuse.** Read-only projection only. |
| Jobs | `web/src/pages/JobsPage.tsx` | **Reuse.** User-supplied items only; no sourcing. |
| Media / image analysis | existing protected media routes | **Reuse** for camera description. No new vision service. |
| Provenance | `hermes_cli/provenance.py` | **Reuse** for build-info proof. |
| A11y gate | `web/src/lib/a11y-audit.ts` | **Extend** with landmark/heading/skip-link rules. |

## What is being added

1. **`web/src/lib/capabilityState.ts` + `hermes_cli/capability_status.py`** — one
   contract for "is this integration actually working", with the six states
   kept separate rather than collapsed into a boolean.
2. **Skip-to-main and a `<main>` landmark** in the app shell. Neither exists in
   the audited release; this is release-blocking for NVDA.
3. **`web/src/lib/nowOrder.ts`** — the Now page's reading order as data, so the
   order is testable rather than implied by JSX nesting.
4. **Push-to-talk voice** and **one-frame camera** as explicit, cancellable,
   session-bound modes.
5. **Security response headers** appropriate to a Tailnet-only deployment.

## What is deliberately not built

- No second dashboard, assistant identity, tracker, profile picker, or app.
- No proactive job sourcing. Packet-ready never means submitted.
- No MCP. Every integration here has a native API or an existing wrapper.
- No home-control mutation. Home Assistant is status and read-only in this pass.
- No financial or messaging mutation. Stripe, Plaid and Twilio get truthful
  status surfaces and adapter interfaces, and nothing else.
- No always-listening microphone, no background camera, no location history.
- No Windows Contrast Theme requirement, no decorative emoji, no cinematic
  motion.

## The capability-status contract

The defect this prevents is inferring authentication from the existence of a
file, a login page, or an open port. Home Assistant is the worked example: the
container is running, the root URL returns 200, `HASS_URL` is set — and the
integration is *not usable*, because there is no token. Three of those four
signals say "working". Collapsing them to one boolean would report a lie.

So each capability reports these independently:

```
supported        the code to talk to it exists in this build
configured       the settings it needs are present
credential       a credential is present (presence only — never the value)
reachable        the endpoint answered
authenticated    the endpoint accepted our credential
proven           a real operation succeeded, with a timestamp
```

`state` is derived from those in a fixed precedence, and every non-operational
state carries exactly one safe next action. `proven_at` is the only field that
answers "did this ever actually work", and it is null until something did.

## Reading order for Now

The order is defined once, in `nowOrder.ts`, and asserted by test — not left to
the order of JSX. Items that have no content are absent, not rendered empty:

1. Page `h1` and system state in plain language
2. Today's selected outcome (from Progress)
3. Income gate and routine completion
4. Next confirmed calendar commitment
5. Active user-provided application / reply / interview item, when one exists
6. Material system exception, only when action is required
7. Ask Imperator
8. Secondary links to deeper modules

## Sequence

- **Phase 1** — this document, contracts, failing tests.
- **Phase 2** — accessible shell (skip link, `main`, one `h1`) and Now.
- **Phase 3** — capability status endpoint and adapters.
- **Phase 4** — push-to-talk and camera.
- **Phase 5** — security headers, release evidence.

## Standing constraints for this run

No deployment, no service restart, no `/home/marco/.hermes` modification, no
account connection, no purchase, no message, no live-data mutation. OAuth
consent is a deliberate browser flow and stays outside automated tests.
