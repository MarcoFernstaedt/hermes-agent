# Building Imperator surfaces — the module system (read this first)

Imperator is meant to grow by **adding modules, not editing the core.** Every
new surface should be a self-contained unit that can be added, disabled, or
removed without touching the shell. This is the default path for *everything*
going forward — for both the human and the agent. If you find yourself hand-editing
`App.tsx`'s nav list, the router list, and the settings page to add one feature,
you are bypassing the contract; stop and pick one of the three module kinds below.

## Decision tree — pick the lightest kind that fits

```
Is the surface mostly records with fields (a list / board / table / form)?
│
├─ YES → 1. CAPABILITY MODULE   (a JSON manifest — no UI code, no build)
│
└─ NO. Does it need a custom, interactive UI of its own?
   │
   ├─ YES → 2. DASHBOARD PLUGIN  (TSX compiled to a removable bundle)
   │
   └─ Only if it needs deep host internals a plugin can't reach:
            3. NATIVE PAGE       (legacy — avoid; migrate toward 1 or 2)
```

Default to **1**. Reach for **2** when the interaction is genuinely custom.
**3 is legacy** — Media and Jobs live here for historical reasons and should
migrate to plugins as they are touched. Do not add new native pages.

---

## 1. Capability module — data-shaped surfaces (no code)

A JSON declaration in `hermes_cli/capabilities/definitions/<id>.json` (or a
plugin's `dashboard/capability.json`) becomes, from the *same* file:

- routes + a nav entry + board/table/form/filters/links UI (host renders it), and
- agent tools (list/get auto, create/advance behind approval, never delete).

Nothing to build or bundle — the host ships one generic renderer. Add the file,
it appears. This is the preferred way to add a tracker, list, or CRUD surface.
See `hermes_cli/capabilities/declarations.py` and existing definitions.

## 2. Dashboard plugin — custom UI, removable (TSX → bundle)

For a surface with its own interactive UI. Authored in **normal TSX**; the build
pipeline compiles it to a self-contained IIFE that the host loads at runtime.
React, the design system, and the API client come from the host at runtime
(via `window.__HERMES_PLUGIN_SDK__`), so the bundle stays tiny and always matches
the host's versions — never re-bundle them.

Layout:

```
plugins/<name>/
  dashboard/
    manifest.json        # name, label, icon, tab {path, position}, entry
    src/index.tsx        # your component; import from "imperator"; register(name, Component)
    dist/index.js        # BUILT artifact (commit it — it's what the host serves)
    plugin_api.py        # optional: FastAPI router mounted at /api/plugins/<name>/
```

Author against the `imperator` virtual module (types:
`web/plugin-sdk/imperator.d.ts`):

```tsx
import { hooks, components, api, register } from "imperator";
function Panel() { const { useState } = hooks; /* … */ return <components.Card/>; }
register("<name>", Panel);   // name must match the manifest
```

Build:

```bash
cd web && npm run build:plugin -- ../plugins/<name>       # one-shot
cd web && npm run build:plugin -- ../plugins/<name> --watch  # during development
```

The host discovers `plugins/<name>/dashboard/manifest.json`, mounts the tab at
`tab.path`, and (if present) mounts `plugin_api.py` at `/api/plugins/<name>/`.
Disabling or deleting the folder removes the surface cleanly.

**Canonical template:** `web/plugin-sdk/example/` is a complete, building
example. Copy it to `plugins/<name>/` to start. Its `dist/index.js` is
regenerated and asserted by `web/src/plugins/build-pipeline.test.ts`, so the
pipeline can't silently rot.

## 3. Native page — legacy, avoid

A page wired directly into `web/src/App.tsx` (`BUILTIN_MODULES`) with a component
under `web/src/pages/`. Only justified when the surface needs host internals no
plugin API exposes. Media and Jobs are here today; treat that as debt, not a
pattern to copy. New native pages should be rejected in review unless they prove
a plugin genuinely can't do it — and if so, that gap is a bug in the plugin SDK
to fix, not a reason to grow the core.

---

## The rule of thumb

Adding a surface should touch **its own directory and nothing else.** Nav,
routing, and tools are derived from the module's own declaration. If a change
spiders across the shell, the surface is the wrong kind — step back to the
decision tree. The app compounds only if every addition is a clean unit.
