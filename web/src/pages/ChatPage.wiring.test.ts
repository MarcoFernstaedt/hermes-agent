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

describe("a new chat does not deliver the old chat's held messages", () => {
  /**
   * The leak, and what investigating it actually found.
   *
   * `startFreshDashboardChat` clears the projection and rotates the session,
   * but a message held for a reconnecting socket survives all of that — the
   * flush fires on the next `ready` and delivers the owner's words from the
   * old chat into the new one, minutes later, under a heading that says the
   * chat is new.
   *
   * Two of the three things the review asked to clear turned out not to need
   * it. `queuedSendsRef` has no producer anywhere in the app: mid-run queueing
   * moved to the gateway (native) and to the `/queue` prefix (terminal), so
   * the local queue is always empty and clearing it clears nothing. Optimistic
   * rows are already discarded with the feed by `resetFreshChatProjection`,
   * which the only caller of `startNew` runs. The held sends were the real one.
   *
   * The fix tags each held send with the conversation it belongs to rather
   * than clearing a buffer from the handler — which only covers one button,
   * and which the React compiler rejects outright because the handler is
   * declared above the buffer it would have to reach.
   */
  it("the hook exposes a generation that only a new session bumps", () => {
    expect(hook).toMatch(/const \[sessionGeneration, setSessionGeneration\]/);
    const startNew = hook.slice(hook.indexOf("const startNew ="));
    expect(startNew).toContain("setSessionGeneration((n) => n + 1)");
    const scheduleReconnect = hook.slice(
      hook.indexOf("const scheduleReconnect"),
      hook.indexOf("const session = new NativeChatSession"),
    );
    expect(scheduleReconnect).not.toContain("setSessionGeneration");
  });

  it("held sends are tagged with the conversation that composed them", () => {
    expect(chatPage).toContain("session: nativeChat.generation,");
  });

  it("every flush of held sends is scoped to the current conversation", () => {
    // Native reconnect, native give-up, and the terminal's own reopen.
    expect(chatPage.split("partitionBySession(").length - 1).toBe(3);
  });

  it("the queue flush skips messages from a replaced conversation", () => {
    expect(chatPage).toMatch(
      /takeNextQueuedSend\(\s*queuedSendsRef\.current,\s*agentRunning,\s*nativeChat\.generation,/,
    );
  });

  it("the flush effects observe the generation, so a change re-runs them", () => {
    // Otherwise the stale entries would sit in the buffer until something
    // unrelated happened to re-fire the effect.
    expect(chatPage.split("nativeChat.generation,").length - 1).toBeGreaterThanOrEqual(4);
  });
});

describe("reconnect covers a socket that dies after it opened", () => {
  it("the hook handles a drop, not only a rejected open", () => {
    expect(hook).toMatch(/onDrop: \(\) => \{/);
    expect(hook).toContain("scheduleReconnect()");
  });

  it("both reasons share one retry budget", () => {
    // Two budgets would double the time the owner spends watching a spinner
    // for what is one outage seen at two moments.
    const occurrences = hook.split("scheduleReconnect()").length - 1;
    expect(occurrences).toBe(2);
    expect(hook.split("MAX_RECONNECT_ATTEMPTS").length - 1).toBe(2);
  });
});

describe("sends carry an idempotency key", () => {
  it("the composer passes the optimistic row's id", () => {
    expect(chatPage).toContain("await transport.send(text, ctx, id)");
  });

  it("every resend path passes the same id it sent with", () => {
    expect(chatPage).toContain("transport.resend(next.text, next.id)");
    expect(chatPage).toContain("transport.resend(item.text, item.id)");
    expect(chatPage).toContain("transport.resend(message.text, message.id)");
  });
});
