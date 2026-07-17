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
    expect(source).toContain('"/jobs": JobsPage');
    expect(source).toContain('path: "/jobs"');
    expect(source).toContain('label: "Jobs"');
    expect(source).toMatch(/id: "operate"[\s\S]*paths: \[[^\]]*"\/jobs"/);
    expect(source).toContain('"/sessions": SessionsPage');
    expect(source).toContain('"/profiles": ProfilesPage');
    expect(source).toContain("persistent ChatPage host");
  });
});
