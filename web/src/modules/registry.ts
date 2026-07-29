/**
 * The module registry.
 *
 * Modules register their `ModuleDefinition` here (in `web/src/modules/index.ts`),
 * and the app shell derives routes, navigation, shell-slot injections and
 * command-palette entries from the registry rather than from hand-maintained
 * lists. This is the single seam the "one directory + one registration" rule
 * depends on.
 *
 * The registry is intentionally tiny and pure so it is trivially testable and
 * has no ordering hazards: registration is synchronous at import time, reads
 * return stable sorted views.
 */

import type { ComponentType } from "react";

import type {
  ModuleCommand,
  ModuleCommandContext,
  ModuleDefinition,
  ModuleGroup,
  ModuleRoute,
} from "@/modules/types";

const _modules = new Map<string, ModuleDefinition>();

/** Register a module. Re-registering the same id replaces the earlier
 *  definition (matches HMR expectations); different ids accumulate. */
export function registerModule(def: ModuleDefinition): void {
  _modules.set(def.id, def);
}

/** All registered modules, in registration order. */
export function getModules(): ModuleDefinition[] {
  return [..._modules.values()];
}

/** Every route contributed by every module, flattened. */
export function getModuleRoutes(): ModuleRoute[] {
  return getModules().flatMap((m) => m.routes);
}

/** Nav entries for one group, sorted by `order` then label. */
export function getModuleNav(group: ModuleGroup) {
  return getModules()
    .filter((m) => m.nav?.group === group)
    .map((m) => ({ id: m.id, ...m.nav! }))
    .sort(
      (a, b) => (a.order ?? 100) - (b.order ?? 100) || a.label.localeCompare(b.label),
    );
}

/** All shell-slot injections contributed by modules. */
export function getModuleShellSlots(): Array<{
  moduleId: string;
  slot: string;
  component: ComponentType;
}> {
  return getModules().flatMap((m) =>
    (m.shellSlots ?? []).map((s) => ({
      moduleId: m.id,
      slot: s.slot,
      component: s.component,
    })),
  );
}

/** Merged default settings across all modules, keyed by module id. */
export function getModuleSettingsDefaults(): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const m of getModules()) {
    if (m.settingsDefaults) out[m.id] = m.settingsDefaults;
  }
  return out;
}

/** All command-palette contributions across modules, resolved with context. */
export function getModuleCommands(ctx: ModuleCommandContext): ModuleCommand[] {
  return getModules().flatMap((m) => (m.commands ? m.commands(ctx) : []));
}

/** Test-only: clear the registry between cases. */
export function _resetModulesForTests(): void {
  _modules.clear();
}
