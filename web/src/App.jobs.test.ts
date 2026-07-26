/// <reference types="node" />

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("native Jobs navigation", () => {
  it("adds Jobs to Operate without replacing chat, sessions, or profiles", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./App.tsx", import.meta.url)),
      "utf8",
    );

    expect(source).toContain('const JobsPage = lazy(() => import("@/pages/JobsPage"))');
    // Jobs (and sessions/profiles) are authored once in BUILTIN_MODULES; routes
    // + nav derive from it. Assert the manifest wiring rather than the old
    // hand-kept route-map/nav literals.
    expect(source).toContain('path: "/jobs", component: JobsPage');
    expect(source).toContain('label: "Jobs"');
    expect(source).toMatch(/id: "operate"[\s\S]*paths: \[[^\]]*"\/jobs"/);
    expect(source).toContain('path: "/sessions", component: SessionsPage');
    expect(source).toContain('path: "/profiles", component: ProfilesPage');
    expect(source).toContain("persistent ChatPage host");
  });
});
