# Imperator Dashboard — Phase 3 Accessibility & QA Report

Scope: the Phase-3 behaviour work (server-persisted settings, event replay,
draft persistence + reconnect, session naming, agent-status live region,
command-palette coverage, PWA offline shell). This report records how those
changes were verified for accessibility, keyboard operability, screen-reader
support, and mobile behaviour.

Primary interaction targets for this app are a screen reader and voice-to-text,
so accessibility is treated as a correctness requirement, not a polish pass.

## 1. Automated audit (axe-core 4, WCAG 2.0/2.1 A + AA)

Scanned at a 390×844 mobile viewport with the app authenticated, one run per
route. axe was injected from a local copy — no external CDN.

Routes scanned: `/sessions`, `/chat`, `/settings`, `/env`, `/git`,
`/learning`, `/system`, `/jobs`, `/media`, `/logs`.

| Route | Violations (A/AA) |
| --- | --- |
| all routes | 0 |

One violation was found and fixed during this pass:

- **`nested-interactive` (serious) on `/chat`** — the pin and kebab buttons
  added to the session rail were nested inside the row's clickable
  `ListItem` (which renders as a `<button>`). Rebuilt the row with the
  stretched-button pattern: a non-interactive container holds a full-row
  select button as a *sibling* of the action buttons, with the label/meta
  layer above it (`pointer-events-none`) so a click falls through to select.
  Re-scan: `/chat` reports **0** violations, whole-row click / keyboard focus
  / context menu / long-press all preserved.

Automated tools catch roughly a third to a half of real issues; the manual
checks below cover the rest.

## 2. Keyboard operability

- **Command palette (⌘K / Ctrl+K)** now covers actions, not just navigation:
  start a new chat and every synced setting toggle (density, reduce motion,
  reply notifications, tool activity, timestamps, token/cost, sound, sidebar
  collapse). Labels reflect current state so the outcome is unambiguous before
  Enter. This gives a keyboard/AT user a pointer-free path to the settings that
  otherwise need the mouse.
- **Session rows** — the select control, pin, and kebab are all in the tab
  order and operable with Enter/Space. The context menu is reachable via the
  keyboard-focusable kebab, not only right-click/long-press.
- **Context menu** (`role="menu"`) traps arrow-key navigation, supports
  Home/End, and dismisses on Escape, outside-click, and scroll; focus moves to
  the first item on open.
- **Inline rename** (row and chat header) — Enter commits, Escape reverts,
  blur commits; the input auto-focuses and selects its text.
- Focus-visible rings are present on all new interactive elements (never
  hover-only affordances for keyboard users).

## 3. Screen-reader support

- **Agent run state** is announced through a dedicated visually-hidden polite
  live region (`AgentLiveStatus`). It announces only settled transitions —
  "Imperator is working", "Imperator finished responding", "Connection lost,
  reconnecting" — debounced so a reconnect blip or fast tool round-trip does
  not stutter, and silent on the initial idle state. The visible status pill
  was demoted to visual-only so the same information is not announced twice
  and noisily on every toggle.
- **Auto-title / regenerate** — a generated title updates the header live
  (consumed from the `session.title` event), so an AT user hears the new name
  without a manual refresh.
- **Row actions** carry explicit `aria-label`s ("Open <title>", "Pin session",
  "Actions for <title>"); the pin exposes `aria-pressed`, the kebab
  `aria-haspopup="menu"`.
- Result feedback that uses colour (e.g. provider-key test results, session
  status dot) always pairs the colour with an icon and/or text, never colour
  alone.

## 4. Mobile & rotation

- **No horizontal overflow** on any scanned route in portrait (390×844) or
  landscape (844×390); each view keeps a single vertical scroll region.
- **Drafts** survive rotation, reload, and navigation away/back (device-local
  localStorage, keyed per session).
- Long-press opens the session context menu on touch; the same menu is
  keyboard-reachable via the kebab.

## 5. PWA / offline

- A service worker provides an offline app shell. Security contract:
  - The navigation document is **never** cached — in loopback mode it carries
    the injected session token. Navigations are network-only with a static,
    token-free offline page as the offline fallback. Verified: the session
    token never appears in Cache Storage, and the server sends `no-store` on
    the document so nothing persists in the browser HTTP cache either.
  - `/api/*`, websockets, and auth routes are never intercepted or cached.
  - Only content-hashed, secret-free assets are cached (cache-first).

## 6. New backend endpoint (flagged)

`POST /api/sessions/{id}/regenerate-title` was added for on-demand title
regeneration. It sits behind the same session-token auth gate as every other
`/api` route, reuses the existing `agent.title_generator.generate_title` and
its `title_generation` auxiliary model slot (no new model configuration), and
returns 422 when there is no complete exchange to title. Covered by backend
tests for the happy path and the incomplete-exchange guard.

## 7. Verification commands

- `tsc --noEmit`, `eslint`, `vitest run` (200 tests) — all green.
- `vite build` — clean.
- `pytest tests/hermes_cli/test_web_server.py` for the new endpoint + settings.
- Live axe-core scan + interaction checks against a running dashboard.

## Known limitations

- True-offline behaviour of the service worker's navigation fallback could not
  be exercised in automation: the headless browser cannot take a loopback
  (127.0.0.1) origin offline, so `fetch` still reached the local server. The
  fallback path itself is minimal and reviewed; the security-critical property
  (no secret cached) was verified directly.
- Automated colour-contrast is covered by axe; the single-scheme Imperator
  palette was not re-tuned in this pass (out of scope — the theme is a
  deliberate design, not a gap).
