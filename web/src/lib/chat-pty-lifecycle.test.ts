import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Guards the PTY spawn gate.
 *
 * ChatPage is mounted persistently so a conversation survives navigation, but
 * the PTY must not be: without a gate, merely visiting another route in a fresh
 * browser context spawned a TUI child and a slash worker. The on-machine report
 * measured 16 Node and 15 Python workers and ~2.4 GB retained, which then
 * churned reconnects and interfered with unrelated UI.
 *
 * This is a source-level assertion rather than a render test because the
 * connect effect owns xterm, a WebSocket and a ticket fetch — none of which are
 * constructible in this environment. The invariant is cheap to state and easy
 * to silently break, so it is worth pinning directly.
 */
describe("chat PTY lifecycle", () => {
  const src = readFileSync(
    resolve(__dirname, "../pages/ChatPage.tsx"),
    "utf8",
  );

  it("latches on first activation and never un-latches", () => {
    // The latch only ever sets true — navigating away keeps the PTY warm.
    expect(src).toMatch(/if \(isActive\) setChatEverShown\(true\)/);
    expect(src).not.toMatch(/setChatEverShown\(false\)/);
  });

  it("refuses to open a PTY before chat has ever been shown", () => {
    expect(src).toMatch(/if \(!chatEverShown\) return;/);
  });

  it("gates before the socket work, not after", () => {
    const gate = src.indexOf("if (!chatEverShown) return;");
    const socket = src.indexOf('api.buildWsUrl("/api/pty"');
    expect(gate).toBeGreaterThan(-1);
    expect(socket).toBeGreaterThan(-1);
    // The bail must precede the connect, or it saves nothing.
    expect(gate).toBeLessThan(socket);
  });

  it("re-runs the connect effect when the latch flips", () => {
    // Without the dependency the gate would never release for a user who
    // opens chat after landing on another route.
    const depsBlock = src.slice(src.indexOf("ptyAttachIdentity,\n    eventSocketReady,"));
    expect(depsBlock.slice(0, 120)).toContain("chatEverShown");
  });
});
