import { afterEach, describe, expect, it, vi } from "vitest";

import {
  connectResilientEventSocket,
  isTerminalDashboardEventFailure,
} from "./resilient-event-socket";

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readyState = FakeSocket.CONNECTING;
  close = vi.fn(() => {
    this.readyState = FakeSocket.CLOSED;
  });
  private listeners = new Map<string, Set<(event: Event) => void>>();

  addEventListener(type: string, listener: (event: Event) => void) {
    const bucket = this.listeners.get(type) ?? new Set();
    bucket.add(listener);
    this.listeners.set(type, bucket);
  }

  emit(type: string, event: Event = new Event(type)) {
    if (type === "open") this.readyState = FakeSocket.OPEN;
    if (type === "close") this.readyState = FakeSocket.CLOSED;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

describe("connectResilientEventSocket", () => {
  afterEach(() => vi.useRealTimers());

  it("mints a fresh URL and reconnects after the event socket closes", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const buildUrl = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("wss://dashboard/events?ticket=first")
      .mockResolvedValueOnce("wss://dashboard/events?ticket=second");
    const onConnected = vi.fn();
    const onDisconnected = vi.fn();

    const stop = connectResilientEventSocket({
      buildUrl,
      socketFactory: (url) => {
        expect(url).toContain(`ticket=${sockets.length ? "second" : "first"}`);
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      onMessage: vi.fn(),
      onConnected,
      onDisconnected,
      initialDelayMs: 250,
      maxDelayMs: 1_000,
    });

    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0].emit("open");
    expect(onConnected).toHaveBeenLastCalledWith(false);

    sockets[0].emit("close", { code: 1006 } as CloseEvent);
    expect(onDisconnected).toHaveBeenCalledWith(1006);
    await vi.advanceTimersByTimeAsync(249);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    sockets[1].emit("open");

    expect(buildUrl).toHaveBeenCalledTimes(2);
    expect(onConnected).toHaveBeenLastCalledWith(true);
    stop();
  });

  it("retries URL-ticket failures and does not strand the feed", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const buildUrl = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("ticket endpoint unavailable"))
      .mockResolvedValueOnce("wss://dashboard/events?ticket=fresh");
    const onDisconnected = vi.fn();

    const stop = connectResilientEventSocket({
      buildUrl,
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      onMessage: vi.fn(),
      onConnected: vi.fn(),
      onDisconnected,
      initialDelayMs: 100,
    });

    await vi.waitFor(() => expect(buildUrl).toHaveBeenCalledTimes(1));
    expect(onDisconnected).toHaveBeenCalledWith(null);
    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    stop();
  });

  it("recovers when URL creation or socket liveness wedges", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const buildUrl = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValue("wss://dashboard/events?ticket=recovered");
    const onDisconnected = vi.fn();

    const stop = connectResilientEventSocket({
      buildUrl,
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      onMessage: vi.fn(),
      onConnected: vi.fn(),
      onDisconnected,
      initialDelayMs: 10,
      watchdogMs: 50,
    });

    await vi.waitFor(() => expect(buildUrl).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(50);
    expect(onDisconnected).toHaveBeenCalledWith(null);
    await vi.advanceTimersByTimeAsync(10);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));

    sockets[0].emit("open");
    await vi.advanceTimersByTimeAsync(50);
    expect(sockets[0].close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10);
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    expect(buildUrl.mock.calls.length).toBeGreaterThanOrEqual(3);
    stop();
  });

  it("stops cleanly without reconnecting a stale channel", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const stop = connectResilientEventSocket({
      buildUrl: vi.fn().mockResolvedValue("wss://dashboard/events?ticket=one"),
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      onMessage: vi.fn(),
      onConnected: vi.fn(),
      onDisconnected: vi.fn(),
      initialDelayMs: 100,
    });

    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    stop();
    expect(sockets[0].close).toHaveBeenCalledOnce();
    sockets[0].emit("close", { code: 1000 } as CloseEvent);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(1);
  });

  it("stops retrying and reports terminal authentication failures", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const onTerminalFailure = vi.fn();
    const buildUrl = vi.fn().mockResolvedValue("wss://dashboard/events?ticket=bad");
    const stop = connectResilientEventSocket({
      buildUrl,
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      onMessage: vi.fn(),
      onConnected: vi.fn(),
      onDisconnected: vi.fn(),
      isTerminalFailure: isTerminalDashboardEventFailure,
      onTerminalFailure,
      initialDelayMs: 10,
    });

    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0].emit("close", { code: 4401 } as CloseEvent);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(buildUrl).toHaveBeenCalledOnce();
    expect(onTerminalFailure).toHaveBeenCalledWith({ code: 4401, error: null });
    stop();
  });

  it("stops retrying when URL minting returns a terminal auth error", async () => {
    vi.useFakeTimers();
    const authError = new Error("/api/auth/ws-ticket: HTTP 401");
    const onTerminalFailure = vi.fn();
    const buildUrl = vi.fn().mockRejectedValue(authError);
    const stop = connectResilientEventSocket({
      buildUrl,
      onMessage: vi.fn(),
      onConnected: vi.fn(),
      onDisconnected: vi.fn(),
      isTerminalFailure: isTerminalDashboardEventFailure,
      onTerminalFailure,
      initialDelayMs: 10,
    });

    await vi.waitFor(() => expect(onTerminalFailure).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(1_000);
    expect(buildUrl).toHaveBeenCalledOnce();
    expect(onTerminalFailure).toHaveBeenCalledWith({ code: null, error: authError });
    stop();
  });
});
