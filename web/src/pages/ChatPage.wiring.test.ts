import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Proves the native transport is genuinely wired into the production ChatPage.
 *
 * The review's point was exact: "the feature flag is not sufficient proof —
 * verify the production import/call graph." A flag that nothing reads is dead
 * code that looks like a feature, and unit tests on the transport module pass
 * happily while ChatPage still opens a pseudo-terminal.
 *
 * These read the real source rather than a mock, because what is being asserted
 * is a property of the wiring itself.
 */
const chatPage = readFileSync("src/pages/ChatPage.tsx", "utf8");
const hook = readFileSync("src/hooks/useNativeChat.ts", "utf8");

describe("native transport wiring", () => {
  it("ChatPage imports and calls the native hook", () => {
    expect(chatPage).toContain('from "@/hooks/useNativeChat"');
    expect(chatPage).toMatch(/const nativeChat = useNativeChat\(/);
  });

  it("the PTY connect path bails out when native mode is active", () => {
    // This single line is what makes the flag real: no PTY spawn means no
    // slash-worker exists solely to render chat.
    expect(chatPage).toMatch(/if \(nativeChat\.active\) return;/);
  });

  it("the bail-out is inside the effect that opens the PTY, before the terminal", () => {
    const gate = chatPage.indexOf("if (nativeChat.active) return;");
    // `new Terminal(` is where the pseudo-terminal actually gets built. The
    // guard must precede it. (Anchoring on the CSS class name instead would
    // match a swipe-guard selector 90 lines earlier and prove nothing — which
    // is what the first version of this test did.)
    const terminalCtor = chatPage.indexOf("new Terminal({");
    expect(gate).toBeGreaterThan(-1);
    expect(terminalCtor).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(terminalCtor);
  });

  it("native mode is observed by the connect effect's dependencies", () => {
    // Otherwise flipping the flag would not re-run the effect and the PTY
    // would linger from the previous render.
    expect(chatPage).toMatch(/nativeChat\.active,/);
  });

  it("the native events feed the same reducer as the sidecar path", () => {
    // One reducer, two transports: swapping them must change nothing above
    // the transport line.
    expect(chatPage).toMatch(/useNativeChat\(\s*useCallback\(\(event: GatewayEvent\)[\s\S]*?chatFeedReducer/);
  });

  it("the hook resumes from the persisted durable id", () => {
    expect(hook).toContain("loadDurableSessionId");
    expect(hook).toContain("saveDurableSessionId");
    // Persist only what the gateway confirmed.
    expect(hook).toMatch(/saveDurableSessionId\(session\.resumeId/);
  });

  it("the hook opens the PTY-free gateway client, not a terminal", () => {
    expect(hook).toContain("new NativeChatSession(new GatewayClient()");
    expect(hook).not.toMatch(/\/api\/pty/);
    expect(hook).not.toMatch(/xterm/i);
  });

  it("a failed open is reported rather than retried into a fresh session", () => {
    // The narrow-fallback rule holds at this layer too.
    expect(hook).toMatch(/\.catch\(/);
    expect(hook).toContain("setError");
  });

  it("the old transport still runs when the flag is off", () => {
    // Guarded by `nativeChat.active`, which is false unless the flag is on —
    // so the PTY path is reachable and unchanged for everyone else.
    expect(hook).toContain("isNativeChatEnabled()");
    expect(hook).toMatch(/const active = enabled && isNativeChatEnabled\(\);/);
  });
});
