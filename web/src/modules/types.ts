/**
 * The frontend module contract.
 *
 * A module is a self-contained feature area (Media, Email, Calendar, Vault,
 * Jobs, Progress). It declares — in one `ModuleDefinition`, registered in one
 * place — its navigation entry, its route(s), any components it injects into
 * app-shell slots (a now-playing strip, an unread badge), its default settings,
 * and its command-palette contributions.
 *
 * Adding a module means creating one directory and registering one definition.
 * It must never mean hand-editing the router, the nav, the settings page and
 * the command palette separately — those all derive from the registry.
 */

import type { ComponentType, LazyExoticComponent } from "react";

/** Top-level navigation groups the sidebar organises modules under. */
export type ModuleGroup = "do" | "read" | "build" | "system";

export interface ModuleNavEntry {
  label: string;
  icon: ComponentType<{ className?: string }>;
  group: ModuleGroup;
  /** Sort order within the group (lower first). Defaults to 100. */
  order?: number;
  /** Path the nav entry links to (usually the module's primary route). */
  path: string;
}

export interface ModuleRoute {
  /** Route path, e.g. "/media". */
  path: string;
  /**
   * Lazily-loaded page component so each module is its own bundle chunk —
   * the media module must not ship in the bundle of someone opening a note.
   */
  element: LazyExoticComponent<ComponentType>;
}

export interface ModuleShellSlot {
  /** A known shell slot name (see web/src/plugins/slots.ts KNOWN_SLOT_NAMES). */
  slot: string;
  component: ComponentType;
}

export interface ModuleCommand {
  id: string;
  label: string;
  /** Extra fuzzy-matchable text (aliases, section). */
  keywords?: string;
  /** Icon component (optional). */
  icon?: ComponentType<{ className?: string }>;
  run: () => void;
}

/** Context passed to a module's command factory so palette entries can
 *  navigate or act without the module reaching into app globals. */
export interface ModuleCommandContext {
  navigate: (path: string) => void;
}

export interface ModuleDefinition {
  /** Stable id, e.g. "media". Also the registry key. */
  id: string;
  /** Sidebar entry. Omit for a route-only or slot-only module. */
  nav?: ModuleNavEntry;
  /** Route(s) the module owns. */
  routes: ModuleRoute[];
  /** Components injected into app-shell slots. */
  shellSlots?: ModuleShellSlot[];
  /** Default settings merged into the global settings store under this id. */
  settingsDefaults?: Record<string, unknown>;
  /** Static command-palette contributions. */
  commands?: (ctx: ModuleCommandContext) => ModuleCommand[];
}
