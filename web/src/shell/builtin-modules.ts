/**
 * Built-in module manifest — the declarative source the app shell derives its
 * route map and sidebar nav from. Each built-in module is authored once as a
 * BuiltinModule; the pure functions here project that list into the exact
 * structures App.tsx used to hand-maintain separately (routes, primary nav,
 * settings-only destinations). Adding or moving a module is now one array entry.
 *
 * Deliberately narrow: sidebar *grouping/order* (NAV_SECTIONS) stays where it
 * is — it references paths and owns its own ordering, and folding it in here
 * would add churn without payoff. Plugin insertion is likewise untouched.
 */
import type { ComponentType } from "react";

export interface BuiltinModuleNav {
  label: string;
  /** i18n key under the app translations; falls back to `label`. */
  labelKey?: string;
  icon: ComponentType<{ className?: string }>;
  /** Reachable via the Settings hub + command palette only, never the sidebar
   *  (models, system, docs, achievements). */
  settingsOnly?: boolean;
}

export interface BuiltinModule {
  path: string;
  /** The page. Omitted only when the route is provided elsewhere (e.g. the
   *  /achievements plugin) but the destination still needs a palette entry. */
  component?: ComponentType;
  /** Omitted for route-only destinations that carry no nav entry (`/`,
   *  `/profiles/new`, `/blocks`). */
  nav?: BuiltinModuleNav;
}

/** The shape App.tsx's nav rendering consumes (matches its NavItem). */
export interface BuiltinNavItem {
  path: string;
  label: string;
  labelKey?: string;
  icon: ComponentType<{ className?: string }>;
}

function toNavItem(m: BuiltinModule & { nav: BuiltinModuleNav }): BuiltinNavItem {
  const item: BuiltinNavItem = { path: m.path, label: m.nav.label, icon: m.nav.icon };
  if (m.nav.labelKey !== undefined) item.labelKey = m.nav.labelKey;
  return item;
}

const hasNav = (
  m: BuiltinModule,
): m is BuiltinModule & { nav: BuiltinModuleNav } => m.nav !== undefined;

/** Route map: every module that owns a page, keyed by path. */
export function deriveBuiltinRoutes(
  modules: readonly BuiltinModule[],
): Record<string, ComponentType> {
  const routes: Record<string, ComponentType> = {};
  for (const m of modules) if (m.component) routes[m.path] = m.component;
  return routes;
}

/** Primary sidebar nav: modules with a non-settings-only nav block, in order. */
export function deriveBuiltinNav(modules: readonly BuiltinModule[]): BuiltinNavItem[] {
  return modules.filter(hasNav).filter((m) => !m.nav.settingsOnly).map(toNavItem);
}

/** Settings-only destinations, re-exposed in the palette (not the sidebar). */
export function deriveSettingsOnlyNav(modules: readonly BuiltinModule[]): BuiltinNavItem[] {
  return modules.filter(hasNav).filter((m) => m.nav.settingsOnly).map(toNavItem);
}

/** Paths kept out of the primary nav (the settings-only set). */
export function deriveSettingsOnlyPaths(modules: readonly BuiltinModule[]): Set<string> {
  return new Set(deriveSettingsOnlyNav(modules).map((n) => n.path));
}
