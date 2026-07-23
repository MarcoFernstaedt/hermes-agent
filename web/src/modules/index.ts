/**
 * Module registration — the ONE place modules are wired into the app.
 *
 * Each module exports a `ModuleDefinition` from its own directory; this file
 * imports and registers them. Adding a module = create its directory, then add
 * one `registerModule(...)` line here. Nothing else in the shell is edited by
 * hand — routes, nav, shell slots, settings and command-palette entries all
 * derive from the registry.
 *
 * (No modules are registered through this path yet; Media in Phase 1 is the
 * first. The existing jobs/life/media pages remain wired the legacy way until
 * they are opportunistically migrated onto this contract.)
 */

export {}; // placeholder until the first module registers here
