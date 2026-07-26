import { describe, expect, it } from "vitest";

import {
  deriveBuiltinNav,
  deriveBuiltinRoutes,
  deriveSettingsOnlyNav,
  deriveSettingsOnlyPaths,
  type BuiltinModule,
} from "./builtin-modules";

// Minimal stand-ins; identity matters, not what they render.
const Page = () => null;
const Icon = () => null;

const modules: BuiltinModule[] = [
  { path: "/", component: Page }, // route-only
  { path: "/a", component: Page, nav: { label: "A", icon: Icon } },
  { path: "/b", component: Page, nav: { label: "B", labelKey: "bKey", icon: Icon } },
  { path: "/blocks", component: Page }, // route-only, no nav
  { path: "/models", component: Page, nav: { label: "Models", icon: Icon, settingsOnly: true } },
  { path: "/achievements", nav: { label: "Ach", icon: Icon, settingsOnly: true } }, // no page
];

describe("builtin-modules derivations", () => {
  it("routes = every module that owns a page, keyed by path", () => {
    const routes = deriveBuiltinRoutes(modules);
    expect(Object.keys(routes).sort()).toEqual(["/", "/a", "/b", "/blocks", "/models"]);
    // A settings-only entry without a component contributes no route.
    expect(routes["/achievements"]).toBeUndefined();
  });

  it("primary nav = nav modules that aren't settings-only, in array order", () => {
    const nav = deriveBuiltinNav(modules);
    expect(nav.map((n) => n.path)).toEqual(["/a", "/b"]);
    // labelKey is carried through, and omitted (not undefined) when absent.
    expect(nav[0]).toEqual({ path: "/a", label: "A", icon: Icon });
    expect(nav[1].labelKey).toBe("bKey");
    // Route-only and settings-only entries never appear here.
    expect(nav.map((n) => n.path)).not.toContain("/blocks");
    expect(nav.map((n) => n.path)).not.toContain("/models");
  });

  it("settings-only nav + paths capture exactly the settings-only entries", () => {
    expect(deriveSettingsOnlyNav(modules).map((n) => n.path)).toEqual([
      "/models",
      "/achievements",
    ]);
    expect([...deriveSettingsOnlyPaths(modules)].sort()).toEqual(["/achievements", "/models"]);
  });
});
