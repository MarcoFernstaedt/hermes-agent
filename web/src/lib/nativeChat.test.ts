// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  NativeChatSession,
  SESSION_NOT_FOUND,
  eventSessionId,
  isNativeChatEnabled,
  isSessionNotFound,
  type NativeChatTransport,
} from "./nativeChat";
import { GatewayRpcError } from "@hermes/shared";
import type { GatewayEvent, GatewayEventName } from "@hermes/shared";

/** A gateway that records calls and lets tests push events by hand. */
function fakeTransport(overrides: Partial<Record<string, unknown>> = {}) {
  const handlers = new Map<string, Array<(ev: GatewayEvent) => void>>();
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  let closed = false;

  const responses: Record<string, unknown> = {
    // The real gateway returns two identities from create: a live transport
    // sid and a durable stored id. Resume accepts the *durable* one and
    // returns a fresh live sid. The original fixture returned only one field,
    // which is precisely why the resume defect passed unit tests.
    "session.create": { session_id: "live-1", stored_session_id: "durable-1" },
    "session.resume": { session_id: "live-2", resumed: "durable-1" },
    "prompt.submit": { status: "ok" },
    "session.interrupt": {},
    ...overrides,
  };

  const transport: NativeChatTransport & {
    calls: typeof calls;
    emit(name: string, ev: GatewayEvent): void;
    isClosed(): boolean;
  } = {
    calls,
    connect: vi.fn(async () => {}),
    request: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params });
      const value = responses[method];
      if (value instanceof Error) throw value;
      return value as never;
    }),
    on: (name: GatewayEventName, handler: (ev: GatewayEvent) => void) => {
      const list = handlers.get(name as string) ?? [];
      list.push(handler);
      handlers.set(name as string, list);
      return () => {
        handlers.set(
          name as string,
          (handlers.get(name as string) ?? []).filter((h) => h !== handler),
        );
      };
    },
    close: () => {
      closed = true;
    },
    emit(name, ev) {
      for (const h of handlers.get(name) ?? []) h(ev);
    },
    isClosed: () => closed,
  };
  return transport;
}

/**
 * Build an event the way the *socket* does: `session_id`, snake case.
 *
 * The first version of this helper used `sessionId`, matching the field the
 * controller was reading — so both were wrong together and the scope-filter
 * test passed against a filter that could never fire. Fixtures have to speak
 * the wire format, or they only prove the code agrees with itself.
 */
function ev(type: string, sessionId?: string): GatewayEvent {
  return { type, session_id: sessionId, payload: {} } as unknown as GatewayEvent;
}

describe("NativeChatSession", () => {
  it("creates a session when there is nothing to resume", async () => {
    const t = fakeTransport();
    const s = new NativeChatSession(t, { onEvent: () => {} });
    const id = await s.open();

    expect(id).toBe("live-1");
    expect(t.calls.map((c) => c.method)).toEqual(["session.create"]);
    expect(s.state).toBe("ready");
  });

  it("keeps the durable id separate from the live one", async () => {
    // The soak defect: one field for both meant resume was attempted with a
    // dead transport sid, the gateway said "session not found", and the
    // fallback quietly created a duplicate session and worker.
    const t = fakeTransport();
    const s = new NativeChatSession(t, { onEvent: () => {} });
    await s.open();

    expect(s.id).toBe("live-1");
    expect(s.resumeId).toBe("durable-1");
  });

  it("resumes with the durable id and adopts the fresh live one", async () => {
    const t = fakeTransport();
    const s = new NativeChatSession(t, { onEvent: () => {} });
    await s.open("durable-1");

    expect(t.calls[0].params).toMatchObject({ session_id: "durable-1" });
    // Events after a reconnect carry the NEW live sid; scoping to the old one
    // would silently drop the whole conversation.
    expect(s.id).toBe("live-2");
    expect(s.resumeId).toBe("durable-1");
  });

  it("does not create a second session after a successful resume", async () => {
    const t = fakeTransport();
    const s = new NativeChatSession(t, { onEvent: () => {} });
    await s.open("durable-1");
    expect(t.calls.map((c) => c.method)).toEqual(["session.resume"]);
  });

  it("refuses to record a live id as a durable one", async () => {
    // A gateway that omits stored_session_id leaves nothing resumable.
    // Pretending the live sid is durable guarantees a failed resume later.
    const t = fakeTransport({ "session.create": { session_id: "live-only" } });
    const s = new NativeChatSession(t, { onEvent: () => {} });
    await s.open();

    expect(s.id).toBe("live-only");
    expect(s.resumeId).toBeNull();
  });

  it("prefers resuming over creating, so a refresh does not leak a worker", async () => {
    // The real soak measured this: a failed resume fell through to create and
    // the slash-worker count went 0 → 2 until the orphan reaper caught up.
    const t = fakeTransport();
    const s = new NativeChatSession(t, { onEvent: () => {} });
    const id = await s.open("durable-1");

    expect(id).toBe("live-2");
    expect(t.calls.map((c) => c.method)).toEqual(["session.resume"]);
  });

  describe("resume failure handling", () => {
    // The fallback must be narrow. Catching every error meant a timeout, a
    // dropped socket or a 500 silently created a duplicate session and a
    // duplicate worker — the identity defect one layer up.

    it("creates exactly one replacement when the server says 4007", async () => {
      const t = fakeTransport({
        "session.resume": new GatewayRpcError(SESSION_NOT_FOUND, "session not found"),
      });
      const s = new NativeChatSession(t, { onEvent: () => {} });
      const id = await s.open("pruned");

      expect(id).toBe("live-1");
      expect(t.calls.map((c) => c.method)).toEqual(["session.resume", "session.create"]);
      expect(t.calls.filter((c) => c.method === "session.create")).toHaveLength(1);
    });

    it.each([
      ["a timeout", new Error("request timed out")],
      ["a dropped socket", new Error("WebSocket closed")],
      ["an authorization failure", new GatewayRpcError(4401, "unauthorized")],
      ["a server error", new GatewayRpcError(5000, "internal error")],
      ["an unrelated rpc error", new GatewayRpcError(4006, "session_id required")],
    ])("does not create a session after %s", async (_label, err) => {
      const t = fakeTransport({ "session.resume": err });
      const s = new NativeChatSession(t, { onEvent: () => {} });

      await expect(s.open("durable-1")).rejects.toThrow();
      expect(t.calls.map((c) => c.method)).toEqual(["session.resume"]);
      expect(s.state).toBe("error");
    });
  });

  it("accepts a reused live id on a quick reconnect", async () => {
    // Inside the orphan grace the gateway hands back the SAME live sid. The
    // client must adopt whatever it returns rather than assuming a fresh one.
    const t = fakeTransport({
      "session.resume": { session_id: "live-1", resumed: "durable-1" },
    });
    const s = new NativeChatSession(t, { onEvent: () => {} });
    await s.open("durable-1");

    expect(s.id).toBe("live-1");
    expect(s.resumeId).toBe("durable-1");
  });

  it("scopes events to the new live id after a cold reconnect", async () => {
    const seen: string[] = [];
    const t = fakeTransport();
    const s = new NativeChatSession(t, { onEvent: (e) => seen.push(e.type) });
    await s.open("durable-1");

    // Old live sid must NOT reach the feed; the new one must.
    t.emit("message.delta", ev("message.delta", "live-1"));
    expect(seen).toEqual([]);
    t.emit("message.delta", ev("message.delta", "live-2"));
    expect(seen).toEqual(["message.delta"]);
  });

  it("reports an unusable gateway as an error rather than a half-open session", async () => {
    const t = fakeTransport({ "session.create": {} });
    const s = new NativeChatSession(t, { onEvent: () => {} });

    await expect(s.open()).rejects.toThrow(/session id/);
    expect(s.state).toBe("error");
  });

  it("forwards this session's events to the reducer", async () => {
    const seen: string[] = [];
    const t = fakeTransport();
    const s = new NativeChatSession(t, { onEvent: (e) => seen.push(e.type) });
    await s.open();

    t.emit("message.start", ev("message.start", "live-1"));
    t.emit("message.delta", ev("message.delta", "live-1"));
    t.emit("message.complete", ev("message.complete", "live-1"));

    expect(seen).toEqual(["message.start", "message.delta", "message.complete"]);
  });

  it("drops events belonging to another session on the same socket", async () => {
    // One socket multiplexes every session. Without this filter a second tab's
    // deltas land in this feed's bubbles and read as the model babbling.
    const seen: string[] = [];
    const t = fakeTransport();
    const s = new NativeChatSession(t, { onEvent: (e) => seen.push(e.type) });
    await s.open();

    t.emit("message.delta", ev("message.delta", "someone-else"));
    expect(seen).toEqual([]);

    t.emit("message.delta", ev("message.delta", "live-1"));
    expect(seen).toEqual(["message.delta"]);
  });

  it("keeps events that carry no session id", async () => {
    // Gateway-level errors arrive unscoped; dropping them would hide failures.
    const seen: string[] = [];
    const t = fakeTransport();
    const s = new NativeChatSession(t, { onEvent: (e) => seen.push(e.type) });
    await s.open();

    t.emit("error", ev("error"));
    expect(seen).toEqual(["error"]);
  });

  it("tracks working state across a turn", async () => {
    const states: string[] = [];
    const t = fakeTransport();
    const s = new NativeChatSession(t, {
      onEvent: () => {},
      onStatusChange: (st) => states.push(st),
    });
    await s.open();
    t.emit("message.start", ev("message.start", "live-1"));
    t.emit("message.complete", ev("message.complete", "live-1"));

    expect(states).toEqual(["connecting", "ready", "working", "ready"]);
  });

  it("returns to ready when a turn ends in an error", async () => {
    const t = fakeTransport();
    const s = new NativeChatSession(t, { onEvent: () => {} });
    await s.open();
    t.emit("message.start", ev("message.start", "live-1"));
    expect(s.state).toBe("working");

    t.emit("error", ev("error", "live-1"));
    expect(s.state).toBe("ready");
  });

  describe("submit", () => {
    it("sends the prompt against the open session", async () => {
      const t = fakeTransport();
      const s = new NativeChatSession(t, { onEvent: () => {} });
      await s.open();

      expect(await s.submit("  hello  ")).toBe("accepted");
      expect(t.calls.at(-1)).toEqual({
        method: "prompt.submit",
        params: { session_id: "live-1", text: "hello" },
      });
    });

    it("treats a mid-turn queue as success, not failure", async () => {
      // The gateway queues rather than rejecting; rendering that as a failed
      // send would make the owner retype a message that is already going to run.
      const t = fakeTransport({ "prompt.submit": { status: "queued" } });
      const s = new NativeChatSession(t, { onEvent: () => {} });
      await s.open();

      expect(await s.submit("later")).toBe("queued");
    });

    it("treats the accepted-with-queued-flag response as queued", async () => {
      // The real gateway returned `{queued: true}` on the accepted path rather
      // than a status string. Both mean "it will run", so both must map to
      // queued — throwing or reporting failure would make the owner retype.
      const t = fakeTransport({ "prompt.submit": { queued: true } });
      const s = new NativeChatSession(t, { onEvent: () => {} });
      await s.open();

      expect(await s.submit("later")).toBe("queued");
    });

    it("treats a steered prompt as success too", async () => {
      const t = fakeTransport({ "prompt.submit": { status: "steered" } });
      const s = new NativeChatSession(t, { onEvent: () => {} });
      await s.open();

      expect(await s.submit("actually, do this")).toBe("steered");
    });

    it("refuses to send before the session is open", async () => {
      const t = fakeTransport();
      const s = new NativeChatSession(t, { onEvent: () => {} });
      await expect(s.submit("hi")).rejects.toThrow(/not open/);
    });

    it("refuses to send an empty message", async () => {
      const t = fakeTransport();
      const s = new NativeChatSession(t, { onEvent: () => {} });
      await s.open();
      await expect(s.submit("   ")).rejects.toThrow(/nothing to send/);
    });
  });

  describe("close", () => {
    it("detaches listeners so a closed session cannot write to a dead feed", async () => {
      const seen: string[] = [];
      const t = fakeTransport();
      const s = new NativeChatSession(t, { onEvent: (e) => seen.push(e.type) });
      await s.open();
      s.close();

      t.emit("message.delta", ev("message.delta", "live-1"));
      expect(seen).toEqual([]);
      expect(t.isClosed()).toBe(true);
      expect(s.state).toBe("closed");
    });

    it("is idempotent, because React cleanups run twice under StrictMode", async () => {
      const t = fakeTransport();
      const s = new NativeChatSession(t, { onEvent: () => {} });
      await s.open();
      s.close();
      expect(() => s.close()).not.toThrow();
    });

    it("refuses to reopen or send after closing", async () => {
      const t = fakeTransport();
      const s = new NativeChatSession(t, { onEvent: () => {} });
      await s.open();
      s.close();

      await expect(s.open()).rejects.toThrow(/closed/);
      await expect(s.submit("hi")).rejects.toThrow(/closed/);
    });
  });

  describe("interrupt", () => {
    it("asks the gateway to wind down the live turn", async () => {
      const t = fakeTransport();
      const s = new NativeChatSession(t, { onEvent: () => {} });
      await s.open();
      await s.interrupt();

      expect(t.calls.at(-1)).toEqual({
        method: "session.interrupt",
        params: { session_id: "live-1" },
      });
    });

    it("stays quiet when the turn already finished", async () => {
      const t = fakeTransport({ "session.interrupt": new Error("no live turn") });
      const s = new NativeChatSession(t, { onEvent: () => {} });
      await s.open();
      await expect(s.interrupt()).resolves.toBeUndefined();
    });

    it("does nothing at all before a session exists", async () => {
      const t = fakeTransport();
      const s = new NativeChatSession(t, { onEvent: () => {} });
      await s.interrupt();
      expect(t.calls).toEqual([]);
    });
  });

  describe("respondApproval", () => {
    it("sends the choice itself, scoped to the live session", async () => {
      // The terminal path typed a menu digit whose meaning depended on how
      // many rows the TUI drew. Here "deny" cannot arrive as anything else.
      const t = fakeTransport({ "approval.respond": { resolved: 1 } });
      const s = new NativeChatSession(t, { onEvent: () => {} });
      await s.open();
      await s.respondApproval("deny");

      expect(t.calls.at(-1)).toEqual({
        method: "approval.respond",
        params: { session_id: "live-1", choice: "deny", all: false },
      });
    });

    it("forwards an approve-all", async () => {
      const t = fakeTransport({ "approval.respond": { resolved: 3 } });
      const s = new NativeChatSession(t, { onEvent: () => {} });
      await s.open();
      await s.respondApproval("always", { all: true });

      expect(t.calls.at(-1)?.params).toMatchObject({ all: true });
    });

    it("refuses before a session exists rather than answering nothing", async () => {
      const t = fakeTransport();
      const s = new NativeChatSession(t, { onEvent: () => {} });
      await expect(s.respondApproval("once")).rejects.toThrow(/not open/);
      expect(t.calls).toEqual([]);
    });

    it("propagates a rejection so the card is not cleared", async () => {
      // Resolving the card on a failed send would show an answered approval
      // the agent is still blocked on.
      const t = fakeTransport({
        "approval.respond": new Error("no pending approval"),
      });
      const s = new NativeChatSession(t, { onEvent: () => {} });
      await s.open();
      await expect(s.respondApproval("once")).rejects.toThrow(/no pending/);
    });
  });

  describe("respondClarify", () => {
    it("answers the request it was asked, by id", async () => {
      const t = fakeTransport({ "clarify.respond": { status: "ok" } });
      const s = new NativeChatSession(t, { onEvent: () => {} });
      await s.open();
      await s.respondClarify("req-7", "blue");

      expect(t.calls.at(-1)).toEqual({
        method: "clarify.respond",
        params: { session_id: "live-1", request_id: "req-7", answer: "blue" },
      });
    });

    it("refuses without a request id", async () => {
      // A positional answer can land on a different question that arrived
      // between render and click.
      const t = fakeTransport();
      const s = new NativeChatSession(t, { onEvent: () => {} });
      await s.open();
      const before = t.calls.length;
      await expect(s.respondClarify("", "blue")).rejects.toThrow(/request/);
      expect(t.calls.length).toBe(before);
    });
  });

  describe("session.info", () => {
    it("is forwarded, so the page needs no second session to read it", async () => {
      // Under native chat the sidebar does not open a sidecar. If this event
      // were dropped, the model and credential-warning surfaces would simply
      // never populate.
      const seen: string[] = [];
      const t = fakeTransport();
      const s = new NativeChatSession(t, {
        onEvent: (event) => seen.push(event.type),
      });
      await s.open();
      t.emit("session.info", ev("session.info", "live-1"));

      expect(seen).toContain("session.info");
    });

    it("is still scoped to this session", async () => {
      const seen: string[] = [];
      const t = fakeTransport();
      const s = new NativeChatSession(t, {
        onEvent: (event) => seen.push(event.type),
      });
      await s.open();
      t.emit("session.info", ev("session.info", "someone-else"));

      expect(seen).toEqual([]);
    });
  });
});

describe("isNativeChatEnabled", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("is off unless explicitly turned on", () => {
    expect(isNativeChatEnabled()).toBe(false);
    window.localStorage.setItem("imperator.nativeChat", "off");
    expect(isNativeChatEnabled()).toBe(false);
  });

  it("is on when the flag is set", () => {
    window.localStorage.setItem("imperator.nativeChat", "on");
    expect(isNativeChatEnabled()).toBe(true);
  });

  it("falls back to the working path when storage is unavailable", () => {
    const spy = vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(isNativeChatEnabled()).toBe(false);
    spy.mockRestore();
  });
});

describe("eventSessionId", () => {
  it("reads the wire field the socket actually sends", () => {
    expect(eventSessionId({ type: "x", session_id: "abc" } as unknown as GatewayEvent)).toBe("abc");
  });

  it("also accepts an already-normalised event", () => {
    expect(eventSessionId({ type: "x", sessionId: "abc" } as unknown as GatewayEvent)).toBe("abc");
  });

  it("treats a missing or empty id as gateway-wide", () => {
    expect(eventSessionId({ type: "x" } as unknown as GatewayEvent)).toBeNull();
    expect(eventSessionId({ type: "x", session_id: "" } as unknown as GatewayEvent)).toBeNull();
    expect(eventSessionId({ type: "x", session_id: 7 } as unknown as GatewayEvent)).toBeNull();
  });
});

describe("isSessionNotFound", () => {
  it("recognises only the gateway's session-not-found code", () => {
    expect(isSessionNotFound(new GatewayRpcError(4007, "session not found"))).toBe(true);
  });

  it("rejects other rpc codes, plain errors and non-errors", () => {
    expect(isSessionNotFound(new GatewayRpcError(4006, "session_id required"))).toBe(false);
    expect(isSessionNotFound(new GatewayRpcError(undefined, "session not found"))).toBe(false);
    // A transport failure whose text happens to match must not qualify —
    // message-sniffing is exactly the fragility the code exists to avoid.
    expect(isSessionNotFound(new Error("session not found"))).toBe(false);
    expect(isSessionNotFound("session not found")).toBe(false);
    expect(isSessionNotFound(null)).toBe(false);
  });
});
