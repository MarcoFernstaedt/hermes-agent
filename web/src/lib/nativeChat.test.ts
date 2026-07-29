// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  NativeChatSession,
  eventSessionId,
  isNativeChatEnabled,
  type NativeChatTransport,
} from "./nativeChat";
import type { GatewayEvent, GatewayEventName } from "@hermes/shared";

/** A gateway that records calls and lets tests push events by hand. */
function fakeTransport(overrides: Partial<Record<string, unknown>> = {}) {
  const handlers = new Map<string, Array<(ev: GatewayEvent) => void>>();
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  let closed = false;

  const responses: Record<string, unknown> = {
    "session.create": { session_id: "new-1" },
    "session.resume": { session_id: "resumed-1" },
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

    expect(id).toBe("new-1");
    expect(t.calls.map((c) => c.method)).toEqual(["session.create"]);
    expect(s.state).toBe("ready");
  });

  it("prefers resuming over creating, so a refresh does not leak a worker", async () => {
    // The gateway documents one leaked slash-worker subprocess per refresh when
    // a client always calls session.create — it even ships an orphan reaper.
    const t = fakeTransport();
    const s = new NativeChatSession(t, { onEvent: () => {} });
    const id = await s.open("old-9");

    expect(id).toBe("resumed-1");
    expect(t.calls.map((c) => c.method)).toEqual(["session.resume"]);
    expect(t.calls[0].params).toMatchObject({ session_id: "old-9" });
  });

  it("falls back to a new session when the old one is gone", async () => {
    const t = fakeTransport({ "session.resume": new Error("4006 unknown session") });
    const s = new NativeChatSession(t, { onEvent: () => {} });
    const id = await s.open("pruned");

    expect(id).toBe("new-1");
    expect(t.calls.map((c) => c.method)).toEqual(["session.resume", "session.create"]);
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

    t.emit("message.start", ev("message.start", "new-1"));
    t.emit("message.delta", ev("message.delta", "new-1"));
    t.emit("message.complete", ev("message.complete", "new-1"));

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

    t.emit("message.delta", ev("message.delta", "new-1"));
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
    t.emit("message.start", ev("message.start", "new-1"));
    t.emit("message.complete", ev("message.complete", "new-1"));

    expect(states).toEqual(["connecting", "ready", "working", "ready"]);
  });

  it("returns to ready when a turn ends in an error", async () => {
    const t = fakeTransport();
    const s = new NativeChatSession(t, { onEvent: () => {} });
    await s.open();
    t.emit("message.start", ev("message.start", "new-1"));
    expect(s.state).toBe("working");

    t.emit("error", ev("error", "new-1"));
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
        params: { session_id: "new-1", text: "hello" },
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

      t.emit("message.delta", ev("message.delta", "new-1"));
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
        params: { session_id: "new-1" },
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
