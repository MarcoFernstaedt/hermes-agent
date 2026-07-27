# Imperator — Mission

Imperator is a personal, desktop-first intelligence hub built on a Hermes Agent
dashboard fork. It is one person's command surface over everything Hermes can do,
and it is designed to **grow as its owner and its agent grow**.

## The three standing jobs

1. **UI is composed, never authored.** A capability is *data* — a declaration of
   entities, fields, lifecycle, views, actions and tools. A fixed renderer we
   wrote once composes existing blocks into surfaces. Creating a feature means
   authoring a validated declaration, never generating markup. Rendering is
   pure and instant: declaration in, composed blocks out, no model call in the
   render path. Same declaration → same UI, always.

2. **Imperator uses and extends every Hermes capability — always gated.** The
   agent can build skills, tools, plugins, MCP connections, capabilities and
   automations, and it reaches for delegation, kanban, cron, memory, search,
   voice, and the rest. Self-extension is **never self-authorisation**: the
   agent proposes, the owner sees exactly what will run and what it can touch,
   the owner approves, then it happens. The bar rises with blast radius.

3. **The platform improves itself, in the open.** It observes its own use and
   health, proposes its own maintenance into the same review queue the agent
   uses, and guards every self-modification behind validation and accessibility
   checks so growth never becomes decay. Priority and layout may adapt
   automatically and reversibly; structure, code and fixes are always proposed
   and approved. Nothing self-applies.

## Invariants (non-negotiable)

- **OAuth and secrets stay server-side.** No telemetry, no external CDNs, no
  third-party scripts. Self-observation data is local, private, the owner's, and
  covered by backup/export/wipe like everything else.
- **Destructive/irreversible actions are always explicitly approved and never
  auto-approvable.** Send/delete/overwrite stay fail-safe at ALWAYS_APPROVAL.
- **The vault is Obsidian's store, never the app's data store.**
- **Accessibility is load-bearing.** Desktop-first, fully keyboard- and
  NVDA-operable; every motion has a non-visual equivalent; reduced-motion
  removes all of it without losing information. A change that fails an axe or
  NVDA check is refused at author time.
- **Alive means caused.** The interface reflects real state changing and the
  agent being present — never motion for atmosphere. One shared realtime
  connection drives every live surface.

## How we build (the standard path)

Every new surface is a module, not a core edit — see `docs/dashboard-modules.md`:
capability manifest (default) → dashboard plugin (custom UI) → native page
(legacy, avoid). Adding a surface should touch its own directory and nothing
else. The app compounds only if every addition is a clean unit.

This mission is the north star for both the owner and the agent. The detailed
build plan lives in `docs/plans/imperator-dynamic-ui-self-improvement-response.md`.
