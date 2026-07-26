# Imperator Master Integration Brief — Verified Response

Status: **plan for approval, no code.** Every claim below was checked against the
installed Hermes source in this repo (paths cited). Where the brief was slightly
off, I say so.

---

## 1. The verified plugin contract, and the module SDK as a layer on it

### What a Hermes plugin can register (verified: `hermes_cli/plugins.py`)

A directory plugin is `plugins/<name>/` (bundled), `~/.hermes/plugins/<name>/`
(user), `./.hermes/plugins/<name>/` (project, opt-in), or a pip entry-point
(`hermes_agent.plugins`). It needs `plugin.yaml` + `__init__.py` with
`register(ctx)`. Later sources override earlier on name collision. User/project
plugins are **opt-in** via `plugins.enabled` in config; bundled backends and
platforms auto-load. `hermes plugins enable/disable <key>` toggles them.

`ctx` (`PluginContext`) can register, all verified in source:

- **`register_tool(name, toolset, schema, handler, check_fn, requires_env,
  is_async, description, emoji, override)`** — delegates to
  `tools.registry.register`, so a plugin tool is indistinguishable from a
  built-in and is therefore an Imperator tool automatically. `override=True`
  replaces a built-in but is **trust-gated** (`plugins.entries.<id>.allow_tool_override`;
  bundled plugins exempt).
- **`register_hook(name, cb)`** over a fixed `VALID_HOOKS` set — includes
  `pre/post_tool_call`, `pre/post_llm_call`, `transform_llm_output`,
  `on_session_start/end/finalize/reset`, `subagent_start/stop`,
  `pre_approval_request` / `post_approval_response` (observers only — cannot
  veto), and `kanban_task_claimed/completed/blocked`.
- **`register_middleware(kind, cb)`** — behavior-changing (can rewrite payloads /
  wrap execution), distinct from observer hooks.
- **`register_command(/slash, handler)`** and **`register_cli_command`** —
  in-session slash commands and `hermes <subcommand>` verbs.
- **`register_platform`**, **`register_image_gen/video_gen/web_search/browser/
  tts/transcription_provider`**, **`register_secret_source`**,
  **`register_dashboard_auth_provider`**, **`register_context_engine`**,
  **`register_skill`**, **`register_auxiliary_task`**,
  **`register_slack_action_handler`**.
- **`ctx.llm`** — host-owned LLM access (run completions on the user's active
  model/auth), fail-closed, gated by `plugins.entries.<id>.llm.*`.
- **`ctx.dispatch_tool` / `ctx.inject_message` / `ctx.profile_name`**.

### The correction the brief needs

**There is no `register_dashboard_tab` on `PluginContext`.** Dashboard tabs are a
*separate* system: `_discover_dashboard_plugins()` in `web_server.py` scans
`plugins/<name>/dashboard/manifest.json` (bundled + user + project). The manifest
declares `{name, label, icon, tab:{path, position:"after:skills"|…, override},
entry:"dist/index.js", css, api:"plugin_api.py"}`. The JS bundle registers a
React component through the frontend plugin SDK (`web/src/plugins`,
`usePlugins`), and the optional `api` field mounts a Python backend.

So a **module is one plugin directory with up to three faces**:

```
plugins/jobs/
  plugin.yaml            # manifest: name, kind, provides_tools
  __init__.py            # register(ctx): registers jobs_* agent tools
  dashboard/
    manifest.json        # tab: {path:"/jobs", position:"after:vault"}
    dist/index.js        # React tab bundle
    plugin_api.py        # optional FastAPI backend for the tab
```

**Kanban already does exactly this** (`plugins/kanban/`: toolset + `dashboard/`
tab at `/kanban` + `plugin_api.py`). It is the reference module. `achievements`
is the second.

### Module SDK design (the layer Imperator adds on top)

The plugin system is sufficient for *registration and lifecycle*. Imperator adds
four things on top, none of which fork the agent core:

1. **A module scaffold/CLI** — `imperator module new jobs` emits the three-face
   skeleton above wired to our blocks and the Capability API, so authoring a
   module is filling in a declaration, not learning two plugin systems.
2. **The Capability API as the default authoring path** (Part 4 below). For
   CRUD-shaped modules the `dashboard/index.js` is a thin host that renders a
   `CapabilityArea` from a declaration; the `__init__.py` generates the agent
   tools from the *same* declaration (this is the "written once, exposed twice"
   engine I already built — `hermes_cli/capabilities/` + `tools/capability_tools.py`).
3. **The shared block catalogue + core services** the tab bundles import, so
   every module looks and behaves consistently and inherits a11y/motion for free.
4. **A Modules page** that drives `hermes plugins enable/disable` + dashboard
   rescan, so install/remove is a UI action.

### Worked example: the jobs tracker end to end

Today jobs is **hardcoded** (`hermes_cli/jobs/{models,repository,router}.py` +
`JobsPage` baked into `App.tsx`) — it fails the brief's own litmus test. Target:

- `plugins/jobs/plugin.yaml` → `name: jobs, kind: standalone, provides_tools:
  [jobs_list, jobs_get, jobs_create, jobs_advance]`.
- `plugins/jobs/__init__.py` → `register(ctx)` loads `jobs.capability.json` and,
  for each declared operation, `ctx.register_tool(...)` with the permission tier
  from Part 5. (Reuses the generator I built; no bespoke wiring.)
- `plugins/jobs/jobs.capability.json` → entity, fields, the
  saved→applied→interview→offer lifecycle, board+table views, `agent.expose`.
- `plugins/jobs/dashboard/manifest.json` → `tab:{path:"/jobs",
  position:"after:vault"}`, `entry: dist/index.js`.
- `dist/index.js` → `<CapabilityArea capability={jobsDecl} />` (blocks do the
  rest). The custom apply-flow queue / one-tap-applied that Jobs has today
  becomes a declared custom action or a small bespoke panel the tab adds beside
  the generic surface.
- Result: dropping the dir in + `plugins enable jobs` installs it; disable +
  delete removes it. No edits to the router, nav, tool registry, or agent core.

**Honest caveat:** the generic entity store + Capability API cover ~80% of jobs.
Its custom apply-queue and mark-applied logic are the 20% that needs either a
declared custom-action (a Capability API extension I'd add) or a small bespoke
panel in the tab bundle. That is the right seam and it does not require forking.

---

## 2. The gateway protocol and the native structured chat client

### Verified (`tui_gateway/server.py`, `event_publisher.py`, `web_server.py`)

- The gateway is newline-delimited JSON-RPC. Methods seen include `prompt`,
  background prompt, `command`, `steer`, `interrupt`, session
  create/resume/info, approval/secret/sudo response, `session_limit`. Streaming
  events include `session.info`, `text`, `tool.started`, `tool.output_risk`,
  `reasoning.available`, `input.request`, `secret.request`, `sudo.request`,
  `exec`, `skill`, and the full `subagent.{start,text,thinking,tool,complete}`
  family.
- `/api/ws` (`web_server.py:16092`) is the in-process gateway WebSocket the
  embedded TUI child attaches to. `/api/pty` is the xterm/PTY bridge the current
  Chat tab actually renders. `/api/pub` (producer) + `/api/events` (subscriber)
  are the **already-working, channel-multiplexed browser pub/sub** — I used them
  all session for live entity events; they carry `_seq` numbers and support
  since-replay.
- The brief is correct: the structured tool events fire in the gateway process
  but the current Chat tab shows ANSI cells over the PTY, so the sidebar tool
  list is empty and the transcript is not a real accessibility tree.

### Design for the native chat client

Do **not** point the browser at `/api/ws` directly (it's the loopback control
channel; exposing it widens the attack surface and duplicates auth). Instead
bridge, reusing infrastructure that already exists:

1. Server bridges gateway events → the existing `/api/events` fanout on a
   per-session channel (same mechanism as entity events). Prompt submission,
   approval responses, steer/interrupt go through a small authorized REST/WS
   producer that forwards into the gateway (mirrors how the PTY sidecar already
   publishes via `/api/pub`).
2. A React `GatewayChat` client renders each event type as a real DOM node via
   the block catalogue: message bubbles, tool cards (args/result/duration/cost),
   reasoning blocks, approval prompts (showing full text of anything to be
   sent), status. Selectable text, correct roles, live region for status.
3. **Multi-device sync falls out for free**: `/api/events` already fans one
   channel to every subscriber with `_seq` + replay, so two devices on the same
   session converge.
4. The xterm/PTY terminal stays as a separate, clearly-labelled **"Terminal
   (raw TUI)"** power-user tab. Both attach to the same agent core, so they never
   diverge.

**Nothing in the protocol blocks this.** The one real cost is enumerating and
versioning the full event catalogue into typed renderers — the gateway is large
and events evolve, so I'd pin a typed schema with a graceful "unknown event"
fallback rather than assume completeness.

---

## 3. Capability inventory checked against the install

| Capability | Exists? | Dashboard surface today | Where the new/better surface lives |
| --- | --- | --- | --- |
| Agent core / streaming / mid-session model switch | ✅ | Chat (PTY) + Models page | Native gateway chat (§2) |
| Skills (create/curate/learn, agentskills.io) | ✅ | `SkillsPage` (basic) | Extend: pending-skill approval diff, curator reports, learn-flow workflow |
| Memory + user model + context files | ✅ (`plugins/memory`, exclusive) | **None** | New Memory module: browser/editor, staged pending writes, per-profile context-file viewer |
| Delegation / subagents | ✅ (`tools/delegate_tool.py`) | **None** | New Delegation panel: live tree (subagent.* events), with honest "not durable" labelling |
| Kanban board | ✅ (`plugins/kanban` + tab) | ✅ `/kanban` tab | Already the exemplar; rebuild card UI on the board block if we want parity polish |
| Cron | ✅ (`cron/`) | ✅ `CronPage` | Extend: run history/outputs, attach to skills/goals |
| Code execution | ✅ | partial (tool calls) | Artifact inspector (code/output/errors) inside the tool card |
| Lifecycle hooks | ✅ (`VALID_HOOKS`) | **None** | Hooks viewer with consent + run history |
| Toolsets per profile | ✅ | partial (`ToolsetConfigDrawer`) | Per-profile toolset manager + Portal routing table |
| MCP | ✅ | ✅ `McpPage` | Fine as-is |
| Profiles | ✅ | ✅ `ProfilesPage` | Ensure every profile-scoped surface shows the write target |
| Providers / fallback / credential pools | ✅ | partial (Models/Keys) | Routing + fallback + last-failover detail |
| Voice mode / TTS / STT | ✅ | partial | Already surfaced some; finish |
| Session search (own past convos) | ✅ (`session_search` tool) | **None** (my entity search ≠ this) | Cross-session recall + promote-to-note/task/memory |
| Batch / trajectory export | ✅ | **None** | Research module; surface only where useful (see §7) |

The highest-value gaps — worth more than any new external integration — are
**Memory, Delegation tree, cross-session recall, and the skills approval/curator
depth**, because they expose intelligence you already have and can't see.

---

## 4. Blocks, highest-risk blocks, Capability API

I built the spine of this already this session, so this is partly "done, verify"
rather than "propose":

- **Block catalogue (built):** DataTable, BoardView, FilterBar, FormFromSchema,
  RecordHeader, FieldGrid, StatBar, ThreePane, EmptyState. **To add per the
  intelligence-hub brief:** Timeline, Gallery/grid, RecordTabs (tabbed
  workspace), SplitPane (resizable panes), ContextMenu, CommandList, TreeView
  (delegation/graph), DiffView (skill approvals), Inspector (tool-call/code
  artifacts), LiveRegion primitive.
- **Three highest-risk blocks:** (1) **BoardView** — DnD + keyboard parity +
  virtualization + live reorder is where a11y and correctness collide; (2)
  **DataTable/virtualized grid** — sort/filter/multi-select/column virtualization
  with a screen-reader-correct grid role; (3) **GatewayChat transcript** — a
  streaming, partially-known event stream that must stay a correct live
  accessibility tree. These three carry the a11y burden for everything else.
- **Capability API (built):** JSON declaration → `/api/capabilities` → dynamic
  routes/nav + `CapabilityArea` (board/table/form/filters/links) **and**
  auto-generated agent tools (`tools/capability_tools.py`), with the destructive
  ops never auto-exposed (no delete tool; writes are APPROVAL). **To add for the
  brief:** declared **custom actions** (beyond CRUD/advance) and a **workflow
  declaration** with dry-run + approval, so Imperator can compose a feature and
  I confirm before it applies.

---

## 5. Build order across all five briefs

1. **Blocks + a11y/motion** (done: ~9; remaining ~10). *Effort: M, ongoing.*
2. **Core services** — entity store, link graph, search, event bus, audit,
   permissions (mostly **built** this session); add action registry, sync
   engine, notifications hardening. *Effort: S remaining.*
3. **Hermes integration layer** — the module SDK/scaffold on the plugin system,
   the native gateway chat client, and the gap surfaces (Memory, Delegation,
   session recall, skills depth). *Effort: L.* This is the phase that turns the
   fork into a platform.
4. **Capability API depth** — custom actions + workflow declarations with
   dry-run/approval. *Effort: M.*
5. **Modules as plugins** — migrate Jobs to the plugin+capability model first (it
   is the proof), then email/calendar/media/vault/research/ingest. *Effort: L,
   incremental per module.*

Order constraint holds: blocks/services → integration layer → Capability API →
modules.

---

## 6. Migration plan (existing areas → blocks + plugin SDK, without losing parity)

- **Strangler pattern, one area at a time.** Keep the hardcoded page working;
  build the plugin/capability version behind it; cut the route over; delete the
  old page only after parity is proven.
- **Parity is proven by a pinning approach** — exactly what I just did for the
  modules-as-manifests refactor: a byte-diff of the old surface's data/behaviour
  vs the new, plus an E2E that the rendered result is identical, before deleting
  the old literal. For upstream parity, keep as much as possible *as plugins*
  (not edits to Hermes source) so a rebase onto upstream Hermes stays clean;
  track the shrinking set of unavoidable core edits in a `FORK-DELTA.md`.
- **Jobs is the first migration and the template.** Nav/router stop being
  hand-edited because the manifest-derived nav (already built) + dashboard-plugin
  tab discovery cover it.

---

## 7. What I'd cut, what's over-engineered, what Hermes already does better

- **Already handled by Hermes — don't rebuild:** durable multi-agent work is
  **kanban**, not a new queue; parallel fan-out is **delegation**, not a bespoke
  job system; scheduling is **cron**; provider fallback + credential pools exist;
  MCP is managed. Surface these, don't re-implement. The brief already says this;
  I'm confirming it held up against the source.
- **Over-engineered / cut first if I could build only two-thirds:**
  1. **Sync engine / full offline-write queue** — real cost, thin payoff for a
     single-user desktop app that's usually online. Ship read-only cache + a
     simple outbox, defer conflict-free sync.
  2. **Trajectory/batch export surfaces** — powerful for fine-tuning, but not for
     your daily use; expose via CLI, skip the UI until you ask.
  3. **A second bespoke chat rewrite** beyond the gateway client — the gateway
     client *is* the answer; don't also build a parallel message store.
- **Unsafe unless done carefully:** the dashboard-plugin `api` field mounts
  Python from a plugin dir — the source notes a past absolute-path RCE there
  (patched). Any Modules "install from URL" flow must treat third-party plugin
  code as untrusted (it already is opt-in + gated); keep install to
  local/reviewed dirs first.
- **The two-thirds I'd build, in order:** (1) native gateway chat, (2) Memory +
  Delegation + session-recall surfaces, (3) Jobs-as-plugin proving the module
  SDK, (4) the remaining high-value blocks, (5) Capability workflow declarations.
  I'd drop sync-engine, trajectory UI, and any module you haven't named yet.

### One thing the briefs overlook

The Capability API I built is **not** currently a Hermes plugin — it's baked into
the dashboard (always-on). That's great for authoring speed but it means a
capability isn't *installable/removable* the way the brief demands. The fix is
small and worth doing: have the module SDK emit a capability as a plugin dir
(the jobs example), so "declared capability" and "installable module" become the
same thing rather than two parallel mechanisms.
