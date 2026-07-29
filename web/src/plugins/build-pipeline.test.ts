import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards the dashboard-plugin build pipeline end-to-end: compile the canonical
 * TSX example and assert the emitted bundle is a self-contained IIFE wired to
 * the host SDK globals — and crucially that it does NOT re-bundle React. If this
 * breaks, rich modules can't be authored in TSX anymore.
 */
describe("dashboard plugin build pipeline", () => {
  const webRoot = resolve(__dirname, "../..");
  const example = resolve(webRoot, "plugin-sdk/example");
  const dist = resolve(example, "dashboard/dist/index.js");

  it("compiles the TSX example into an IIFE bound to the host SDK", () => {
    execFileSync("node", ["scripts/build-dashboard-plugin.mjs", example], {
      cwd: webRoot,
      stdio: "pipe",
    });
    const out = readFileSync(dist, "utf8");

    // Self-contained IIFE.
    expect(out).toMatch(/\(\(\)\s*=>\s*\{/);
    // Pulls React / DS / api from the host globals, never re-bundles them.
    expect(out).toContain("__HERMES_PLUGIN_SDK__");
    expect(out).toContain("__HERMES_PLUGINS__");
    // Registers under the manifest name.
    expect(out).toContain(".register(");
    expect(out).toContain("example-panel");
    // JSX compiled to createElement.
    expect(out).toContain("createElement");
    // React itself is NOT bundled (would balloon the file past a few kb).
    expect(out.length).toBeLessThan(20_000);
    expect(out).not.toContain("react-dom");
  });
});
