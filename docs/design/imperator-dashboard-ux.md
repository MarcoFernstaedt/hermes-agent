# Imperator Dashboard — UX & Design Plan

This document is the working design spec for the Imperator systems
dashboard (the `web/` SPA plus the server-rendered `/login` page). It
records the visual identity, the navigation model, the responsive rules,
and the intended user journey — so future pages and features extend one
coherent product instead of accreting screens.

## 1. Identity: one scheme, no themes

Theme switching was removed on purpose. Imperator is a single operator's
command surface, and it carries **one** brand identity everywhere —
login, dashboard, terminal:

| Token | Value | Role |
|-------|-------|------|
| Canvas | `#0f0b1e` | "Imperial night" — deep obsidian violet |
| Accent / primary text | `#e8c87a` | "Aurum" — imperial gold |
| Ivory foreground (login) | `#f6f1e4` | Headings / body on the login card |
| Destructive | `#f0523f` | Errors, deletes |
| Success | `#3dd68c` | Healthy states |
| Warning | `#f5a623` | Attention states |
| Series accents | `#e8c87a` / `#a78bfa` | Input vs. output tokens in charts |
| Terminal | `#0a0716` bg / `#f0e2c0` fg | Embedded TUI pane |

Rationale: the name *Imperator* is Roman — the palette is Tyrian purple
darkened to a near-black canvas with imperial gold chrome. Gold on deep
violet holds ≈11:1 contrast (WCAG AAA for normal text); the DS derives
`text-secondary` / `text-tertiary` from the accent and both stay above
4.5:1.

Where the values live (keep in sync — each file says so in a comment):

- `web/src/themes/presets.ts` — the single `imperatorTheme` definition.
- `web/src/index.css` — the same values as static `:root` defaults so the
  first paint is on-brand before React mounts.
- `hermes_cli/dashboard_auth/login_page.py` — the server-rendered login
  (no React dependency), same palette.

Typography stays on the system font stack (fast, offline-friendly, no
external font fetch) with the Nous DS brand fonts (Collapse / Rules
Compressed / Mondwest) for chrome, per `web/README.md`'s typography
rules. Type scale, opacity floors, and semantic text tokens in that
README still apply to all new UI.

## 2. The user journey

### 2.1 Signing in

- **Local (loopback) launch** — `hermes dashboard` opens straight into
  the dashboard; no auth gate, no login page.
- **Gated (remote) launch** — the user lands on `/login`: the
  "PRIVATE SYSTEM / IMPERATOR" wordmark over a single card listing the
  configured providers (password form and/or OAuth buttons). One action,
  nothing else to parse. After sign-in they return to the page they
  originally asked for (`next=` is threaded through the flow).

### 2.2 Landing: Sessions

`/` redirects to **Sessions** — the "what has my agent been doing"
answer, which is the right first question for an agent console. The page
leads with search, live-session badges, and the most recent
conversations. From any row the user can resume in Chat (▶), rename,
export, or delete.

### 2.3 Orientation: the navigation model

Navigation is grouped by intent, not by API surface. The sidebar (desktop)
and drawer (mobile) present the same four groups:

| Group | Destinations | User intent |
|-------|--------------|-------------|
| *(pinned)* | Chat | "Talk to Imperator now" |
| **Operate** | Sessions, Files, Analytics¹, Logs | "What is/was it doing?" |
| **Automate** | Cron, Skills, Plugins, MCP, Webhooks | "Extend it / make it recur" |
| **Connect** | Channels, Pairing, Profiles | "Wire it to the world & people" |
| **Settings** | Models, Config, Keys, System, Docs | "Configure the machine" |

¹ Analytics stays gated behind `dashboard.show_token_analytics`.

Plugin-contributed pages keep their own labelled group below the core
groups, and items no group claims fall into Settings — so navigation can
grow (the "expanding into so much more" case) without any page becoming
unreachable or the top level getting longer. New features should join an
existing group first; only add a fifth group when a genuinely new intent
appears.

Below the nav, the sidebar keeps the **System actions** strip (gateway
status, restart, update) and the auth/footer block — glanceable state,
never mixed into navigation.

### 2.4 Doing work: the per-page pattern

Every page follows the same skeleton, which is what makes the dashboard
learnable:

1. **Page header** (sticky, one row on ≥sm): title on the left, the
   page's primary action(s) on the right.
2. **Content**: cards for object lists (sessions, channels, skills…),
   each card carrying its own inline actions.
3. **Destructive actions** always confirm via dialog; long-running ops
   stream their log into the page rather than blocking.
4. Managing a different profile shows the amber scope banner so the
   write target is never ambiguous.

### 2.5 Chat

Chat is a first-class chat app, not a terminal. The default surface is
the **bubble feed** — the interaction model users know from ChatGPT and
Claude:

- User messages right-aligned, Imperator replies left-aligned and
  rendered as **markdown** (code blocks, lists, links) with a streaming
  caret while the reply is in flight.
- A bottom **composer**: auto-growing textarea, Enter to send /
  Shift+Enter for newline, slash-command popover, image paste & drop,
  and a send button that flips to **Stop** while the agent is working.
- **Approvals and clarifications arrive as interactive bubbles.** When
  the agent needs permission (dangerous command, pending write) the
  feed shows an "Approval required" card with *Allow once / Allow this
  session / Always allow / Deny* buttons; clarify prompts render their
  choices as buttons plus a free-form path through the composer. Answers
  are delivered over the same PTY WebSocket the terminal uses, and the
  resolved choice is recorded on the bubble ("Approved for session",
  etc.), so the transcript stays an audit trail.
- Tool/system activity folds into collapsible "Operational output" rows
  so the conversation stays readable while nothing is hidden.
- Time-of-day greeting on the empty state; unread "New messages" pill
  when scrolled up.

Under the hood the PTY remains the execution authority: the feed is a
read-only projection of the structured event stream (`/api/events`),
with history hydrated from the session store. The **raw console**
(xterm) stays one toggle away for full-fidelity TUI access, and the
right rail (model picker + session list) folds into a slide-over sheet
on narrow screens. The page is mounted persistently so switching tabs
never kills the session.

### 2.6 Branding rule

No user-visible "Hermes" or "Nous Research": the product name is
**Imperator**; the org line is **Imperator Systems**. Frontend copy is
rebranded at the source; copy that arrives from the backend (skill,
plugin, channel, config, and env descriptions) is rebranded at render
time via `imperatorBrand()` in `web/src/lib/imperator-branding.ts`.
Exceptions, on purpose: literal CLI commands (`hermes update`,
`hermes gateway start`), env keys (`HERMES_*`), URLs, and the Nous
Portal product name — changing those would break real instructions and
integrations.

## 3. Responsive rules

Breakpoints follow Tailwind defaults; the shell switches at `lg` (1024px).

- **Desktop (≥1024px)** — sticky sidebar (collapsible to an icon rail
  with tooltips), single content column, page header in one row.
- **Tablet & phone (<1024px)** — top bar (menu button + wordmark),
  full-height navigation drawer, and a **fixed bottom tab bar** with the
  four primary destinations (Chat, Sessions, Channels, System) plus
  **Menu** opening the drawer. The bar hides on /chat (the terminal and
  the software keyboard need the height) and while the drawer is open.
- Content column gets extra bottom padding on mobile so nothing scrolls
  under the tab bar; safe-area insets are respected on notched phones.

Anti-zoom guarantees (the "looks zoomed in / weird on my phone" class of
bugs):

- `<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">`
- `text-size-adjust: 100%` — no mobile-browser text inflation.
- Form controls render at ≥16px on phone widths — iOS Safari never
  auto-zooms a focused field.
- Wide content (tables, logs, code) scrolls inside its own
  `overflow-x-auto` container; the page body never scrolls horizontally.
- Touch targets ≥44px on interactive chrome (nav links, tab bar, form
  buttons).

## 4. Install & performance

- The dashboard is **installable as an app** (PWA manifest + Imperator
  icon set — gold laurel "I" on imperial night): Add to Home Screen on
  phones/tablets launches it standalone with on-brand splash and status
  bar (`theme-color #0f0b1e`).
- Every management page is **code-split** into its own chunk; only the
  shell and the persistent chat host load up front (ChatPage stays a
  static import because the persistent host mounts it on app load).
  Keep new pages behind `lazy()` in `App.tsx` so the phone's first
  paint stays lean.

## 5. Extending the dashboard

When adding a page or feature:

1. Pick the nav group by user intent (see §2.3) and add the path to
   `NAV_SECTIONS` in `web/src/App.tsx`.
2. Use the page skeleton from §2.4 — header slots via `usePageHeader`,
   cards for lists, confirm dialogs for destructive ops.
3. Use semantic tokens only (`text-text-*`, `bg-card`, `border-border`,
   `text-success`…) — never raw hex in components; the scheme stays
   swappable in one file.
4. Check the phone layout before shipping: no horizontal scroll, tap
   targets ≥44px, content clears the bottom tab bar.
