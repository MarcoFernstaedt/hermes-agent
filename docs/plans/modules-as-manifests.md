# Plan: Modules-as-manifests (built-in shell wiring)

Status: **proposed** (no code yet). Scope decision requested before implementation.

## Goal

Author each built-in module (Email, Calendar, Vault, Jobs, Sessions, …) as a
single declarative descriptor, so the app shell derives its route map and
sidebar nav entry from one source instead of the same module being spelled out
across several hand-kept structures. This mirrors what capabilities and plugins
already do ("declare, don't hand-wire").

## Non-goals

- **No change to any page.** Module *pages* keep their current bespoke code and
  behavior. This refactors only how they're *registered*.
- **No user-facing change.** Nav, routes, ordering, i18n labels, the Settings
  hub, plugin insertion, and the analytics gate must render byte-identically.
- **Not a capability conversion.** Built-in modules stay real pages; they are
  not being turned into Capability declarations (that's a separate, larger
  question and would lose custom logic).

## Current state — the structures a module is spread across (`web/src/App.tsx`)

1. `BUILTIN_ROUTES_CORE` — `{ path: Component }`, ~30 entries (superset of nav).
2. `BUILTIN_NAV_REST` — ordered `NavItem[]` (~24) with `label`, optional i18n
   `labelKey`, `icon`.
3. `NAV_SECTIONS` — presentational sidebar groups (Operate / Automate / Connect
   / Settings), each listing member **paths in its own explicit order**.
4. `SETTINGS_ONLY_PATHS` + `SETTINGS_ONLY_NAV` — routes reachable only via the
   Settings hub (models, system, docs, achievements): out of the sidebar, but
   re-exposed in the command palette.
5. `buildNavItems` / `partitionSidebarNav` / `ICON_MAP` — plugin insertion and
   built-in-vs-plugin split. **Out of scope** (plugin-side, unchanged).

### Facts that constrain the design (verified)

- **Routes ⊋ nav.** Many routes (`/models`, `/system`, `/docs`,
  `/profiles/new`, `/blocks`, …) are not sidebar entries. The descriptor needs
  an optional `nav` block, not a 1:1 assumption.
- **Section order ≠ nav-list order.** `NAV_SECTIONS` orders each section by its
  own `paths[]`, independent of `BUILTIN_NAV_REST` order (e.g. Settings section
  is settings→config→env, but the nav list is config→env→settings). So section
  order can **not** be derived from descriptor array order.
- **Two nav items belong to no section.** `/search` and `/graph` are in the nav
  list but no `NAV_SECTION`, so they land in the sidebar's catch-all group. This
  must be preserved.
- **i18n.** Some nav items carry a `labelKey` (`sessions`, `analytics`, `logs`,
  `cron`, `skills`, `plugins`, `profiles`, `config`→"keys", `env`, `models`,
  `documentation`). The descriptor must carry `labelKey` through untouched.

## Proposed design (reduced, low-risk scope)

Introduce one array, `web/src/shell/builtin-modules.ts`:

```ts
interface BuiltinModule {
  path: string;
  component: ComponentType;
  nav?: {                    // omit → route only (not in sidebar)
    label: string;
    labelKey?: NavLabelKey;  // i18n, passed through verbatim
    icon: LucideIcon;
    settingsOnly?: boolean;  // in palette only, not the sidebar (models/system/…)
  };
}
```

Derive the existing structures from it (pure functions, unit-tested):

- `BUILTIN_ROUTES_CORE` = every module → `{path: component}`.
- `BUILTIN_NAV_REST` = modules with `nav && !settingsOnly`, in array order.
- `SETTINGS_ONLY_NAV` / `SETTINGS_ONLY_PATHS` = modules with `nav.settingsOnly`.

**Leave `NAV_SECTIONS` exactly as-is.** It only references paths and owns its own
ordering; folding section membership+order into the descriptor is where most of
the risk and churn lives, for no extra payoff. Keeping it separate shrinks the
blast radius to the route/nav-item derivation only.

Net effect: adding or moving a built-in module becomes editing one array entry
(plus, if it should sit in a specific sidebar group, one line in `NAV_SECTIONS`)
instead of touching three places.

## Migration steps (each independently verifiable)

1. Add `builtin-modules.ts` with the descriptor array reproducing today's data.
2. Add a **pinning test** that builds the derived structures and asserts they
   deep-equal the current hardcoded `BUILTIN_ROUTES_CORE`, `BUILTIN_NAV_REST`,
   `SETTINGS_ONLY_NAV`, and `SETTINGS_ONLY_PATHS`. (Temporarily import both the
   old constants and the derived ones; the test is the equivalence oracle.)
3. Swap `App.tsx` to consume the derived structures; delete the old literals.
4. Re-point the pinning test at a frozen snapshot (inline expected JSON of
   paths/labels/order) so it keeps guarding ordering after the literals are gone.

## Verification

- **Pinning unit test** (step 2/4): routes set, nav order, labelKeys, and
  settings-only split are identical.
- **tsc / eslint / vitest / build** green.
- **E2E**: sidebar renders the same sections in the same order with the same
  labels; every route still resolves; `/search` and `/graph` still appear in the
  catch-all group; a settings-only path (e.g. `/models`) is absent from the
  sidebar but reachable from the palette.

## Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| Silent nav reordering | Pinning test asserts exact order before literals are removed. |
| Dropped i18n `labelKey` | Descriptor carries `labelKey`; test compares it. |
| Settings-only leak into sidebar | `settingsOnly` flag + test on the split. |
| Plugin insertion regressions | `buildNavItems`/`partition` untouched; out of scope. |
| Hard to review big diff | Land in the 4 steps above; step 3 is a pure swap. |

## Rollback

Pure refactor on a feature branch; revert the commit. No schema, storage, or API
changes — nothing to migrate back.

## Estimate

~1 focused session. Low risk given the pinning test gates every step; the only
irreversible-feeling part (deleting the literals) happens only after the derived
output is proven identical.
