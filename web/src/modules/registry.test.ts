import { lazy } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetModulesForTests,
  getModuleCommands,
  getModuleNav,
  getModuleRoutes,
  getModuleSettingsDefaults,
  getModuleShellSlots,
  getModules,
  registerModule,
} from "./registry";
import type { ModuleDefinition } from "./types";

const Dummy = lazy(async () => ({ default: () => null }));
const Strip = () => null;

function makeModule(id: string, extra: Partial<ModuleDefinition> = {}): ModuleDefinition {
  return {
    id,
    routes: [{ path: `/${id}`, element: Dummy }],
    ...extra,
  };
}

describe("module registry", () => {
  beforeEach(() => _resetModulesForTests());

  it("registers and lists modules in registration order", () => {
    registerModule(makeModule("media"));
    registerModule(makeModule("email"));
    expect(getModules().map((m) => m.id)).toEqual(["media", "email"]);
  });

  it("re-registering the same id replaces the definition", () => {
    registerModule(makeModule("media", { settingsDefaults: { a: 1 } }));
    registerModule(makeModule("media", { settingsDefaults: { a: 2 } }));
    expect(getModules()).toHaveLength(1);
    expect(getModuleSettingsDefaults().media).toEqual({ a: 2 });
  });

  it("flattens routes across modules", () => {
    registerModule(makeModule("media"));
    registerModule({
      id: "notes",
      routes: [
        { path: "/notes", element: Dummy },
        { path: "/notes/:id", element: Dummy },
      ],
    });
    expect(getModuleRoutes().map((r) => r.path)).toEqual([
      "/media",
      "/notes",
      "/notes/:id",
    ]);
  });

  it("sorts nav within a group by order then label", () => {
    registerModule(
      makeModule("jobs", {
        nav: { label: "Jobs", icon: Strip, group: "do", order: 20, path: "/jobs" },
      }),
    );
    registerModule(
      makeModule("calendar", {
        nav: { label: "Calendar", icon: Strip, group: "do", order: 10, path: "/calendar" },
      }),
    );
    registerModule(
      makeModule("email", {
        nav: { label: "Email", icon: Strip, group: "read", path: "/email" },
      }),
    );
    expect(getModuleNav("do").map((n) => n.id)).toEqual(["calendar", "jobs"]);
    expect(getModuleNav("read").map((n) => n.id)).toEqual(["email"]);
  });

  it("collects shell slots and settings defaults", () => {
    registerModule(
      makeModule("media", {
        shellSlots: [{ slot: "post-main", component: Strip }],
        settingsDefaults: { volume: 50 },
      }),
    );
    const slots = getModuleShellSlots();
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({ moduleId: "media", slot: "post-main" });
    expect(getModuleSettingsDefaults()).toEqual({ media: { volume: 50 } });
  });

  it("resolves command contributions with context", () => {
    const navigate = vi.fn();
    registerModule(
      makeModule("media", {
        commands: (ctx) => [
          { id: "media.open", label: "Open Media", run: () => ctx.navigate("/media") },
        ],
      }),
    );
    const cmds = getModuleCommands({ navigate });
    expect(cmds).toHaveLength(1);
    cmds[0].run();
    expect(navigate).toHaveBeenCalledWith("/media");
  });
});
