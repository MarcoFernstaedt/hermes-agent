# Authoring an Imperator module

A module is a self-contained feature area with **one backend service** exposed
**twice** — to me through the UI, to the agent through tools. Adding one means
creating a directory and registering it in one place per side. If you find
yourself editing the router list, the nav, the settings page and the tool
registry by hand, the contract is being bypassed.

## Backend (`hermes_cli/<mod>/`)

```
hermes_cli/<mod>/
  __init__.py
  models.py       # dataclasses / pydantic models
  service.py      # THE capability — the only place logic lives
  <provider>.py   # external adapter (declares its rate limits)
  repository.py   # SQLite data access (local modules)
  router.py       # create_<mod>_router(authorize) -> APIRouter, calls service
  tools.py        # registers agent tools -> call the SAME service
  settings.py     # settings schema / defaults
```

Register it (Media is the first to use this path):

```python
from hermes_cli.modules import register_module, ModuleSpec
from hermes_cli.<mod>.router import create_<mod>_router
from hermes_cli.<mod>.tools import register_tools

register_module(ModuleSpec(
    id="<mod>",
    create_router=create_<mod>_router,
    register_tools=register_tools,
    startup=<mod>_migrate,           # optional, idempotent
    settings_defaults={...},
))
```

`mount_modules(app, _require_token)` includes the router; `register_all_tools()`
registers the tools; `run_startup()` runs migrations. Every `/api` route is
gated by `_require_token` automatically.

Agent tools **must not** re-implement provider calls. For OAuth-backed modules
they call the dashboard's own localhost API with the session token, so there is
one service, one encrypted token store (`hermes_cli.secure_store`), one audit
trail (`hermes_cli.audit_log`). Every write tool declares a permission tier via
`hermes_cli.module_permissions.register_tool_permission` — `AUTO`, `APPROVAL`,
or `ALWAYS_APPROVAL` (send/delete/overwrite). Destructive tools can never be
auto-approved.

## Frontend (`web/src/modules/<mod>/`)

```
web/src/modules/<mod>/
  index.ts        # exports a ModuleDefinition
  <Mod>Page.tsx   # lazy-loaded route component (own bundle chunk)
  api.ts          # typed client -> own backend ONLY (never Google/Spotify direct)
  store.ts        # uses the shared data/cache hook (no bespoke fetching)
```

Register it in `web/src/modules/index.ts`:

```ts
import { registerModule } from "@/modules/registry";
import { mediaModule } from "@/modules/media";
registerModule(mediaModule);
```

The `ModuleDefinition` declares nav entry (group + order), lazy routes, shell-slot
components (e.g. a now-playing strip), settings defaults, and command-palette
contributions. The shell derives routes, nav, slots, settings and palette entries
from the registry — nothing else is hand-edited.

## Accessibility per module

Each module ships with its own accessibility pass — automated (axe) → keyboard
only → NVDA in Chrome and Firefox — reported before the module is considered
done. Composite widgets (lists, trees, grids) implement correct roles and
keyboard interaction so NVDA browse/focus mode switching happens naturally.
