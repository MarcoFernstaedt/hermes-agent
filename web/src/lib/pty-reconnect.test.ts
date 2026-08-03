import { afterEach, describe, expect, it, vi } from "vitest";

import {
  scheduleAutomaticPtyReconnect,
  shouldBlockPtyInput,
  shouldReconnectPtyOnPageResume,
} from "./pty-reconnect";
import {
  knownPtyInput,
  ptyInputStateForConnection,
  type PtyInputState,
} from "./pty-mobile-input";

afterEach(() => {
  vi.useRealTimers();
});

describe("scheduleAutomaticPtyReconnect", () => {
  it("marks same-PTY input unknown before the automatic reconnect nonce changes", () => {
    vi.useFakeTimers();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let reconnectNonce = 0;
    let inputState: PtyInputState = knownPtyInput("");
    const callbackOrder: string[] = [];

    const delay = scheduleAutomaticPtyReconnect({
      hasPendingTimer: () => timer !== null,
      getAttempt: () => attempt,
      setAttempt: (value: number) => { attempt = value; },
      setTimer: (value: ReturnType<typeof setTimeout> | null) => { timer = value; },
      setBanner: () => undefined,
      setLastCloseCode: () => undefined,
      setPtyState: () => undefined,
      setInputUnknown: () => {
        inputState = ptyInputStateForConnection(false);
        callbackOrder.push("input-unknown");
      },
      incrementReconnectNonce: () => {
        callbackOrder.push("reconnect-nonce");
        reconnectNonce += 1;
      },
      closeCode: 1006,
    });

    expect(delay).toBe(250);
    expect(inputState.certainty).toBe("known");
    vi.advanceTimersByTime(250);
    expect(inputState).toEqual({ certainty: "unknown", value: null });
    expect(callbackOrder).toEqual(["input-unknown", "reconnect-nonce"]);
    expect(reconnectNonce).toBe(1);
    expect(timer).toBeNull();
  });

  it("preserves reconnect deduplication and capped exponential backoff", () => {
    vi.useFakeTimers();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let reconnects = 0;
    let unknownResets = 0;
    const options = {
      hasPendingTimer: () => timer !== null,
      getAttempt: () => attempt,
      setAttempt: (value: number) => { attempt = value; },
      setTimer: (value: ReturnType<typeof setTimeout> | null) => { timer = value; },
      setBanner: () => undefined,
      setLastCloseCode: () => undefined,
      setPtyState: () => undefined,
      setInputUnknown: () => { unknownResets += 1; },
      incrementReconnectNonce: () => { reconnects += 1; },
      closeCode: 1006,
    };

    for (const delay of [250, 500, 1000, 2000, 3000, 3000]) {
      expect(scheduleAutomaticPtyReconnect(options)).toBe(delay);
      expect(scheduleAutomaticPtyReconnect(options)).toBeNull();
      vi.advanceTimersByTime(delay);
    }

    expect(attempt).toBe(5);
    expect(unknownResets).toBe(6);
    expect(reconnects).toBe(6);
  });
});

describe("shouldReconnectPtyOnPageResume", () => {
  it("reconnects a missing socket when the active page becomes visible", () => {
    expect(
      shouldReconnectPtyOnPageResume({
        isActive: true,
        visibilityState: "visible",
        online: true,
        socketReadyState: null,
        ptyState: "reconnecting",
      }),
    ).toBe(true);
  });

  it("reconnects closed or closing sockets on visible resume", () => {
    for (const socketReadyState of [2, 3]) {
      expect(
        shouldReconnectPtyOnPageResume({
          isActive: true,
          visibilityState: "visible",
          online: true,
          socketReadyState,
          ptyState: "reconnecting",
        }),
      ).toBe(true);
    }
  });

  it("does not reconnect an open socket on visible resume", () => {
    expect(
      shouldReconnectPtyOnPageResume({
        isActive: true,
        visibilityState: "visible",
        online: true,
        socketReadyState: 1,
        ptyState: "open",
      }),
    ).toBe(false);
  });

  it("reconnects a still-connecting socket when the page is already in reconnecting state", () => {
    expect(
      shouldReconnectPtyOnPageResume({
        isActive: true,
        visibilityState: "visible",
        online: true,
        socketReadyState: 0,
        ptyState: "reconnecting",
      }),
    ).toBe(true);
  });

  it("does not reconnect while the page is hidden", () => {
    expect(
      shouldReconnectPtyOnPageResume({
        isActive: true,
        visibilityState: "hidden",
        online: true,
        socketReadyState: 3,
        ptyState: "reconnecting",
      }),
    ).toBe(false);
  });

  it("defers reconnect while offline", () => {
    expect(
      shouldReconnectPtyOnPageResume({
        isActive: true,
        visibilityState: "visible",
        online: false,
        socketReadyState: 3,
        ptyState: "reconnecting",
      }),
    ).toBe(false);
  });

  it("does not fire a redundant reconnect while a connect is in flight (wsRef not yet assigned)", () => {
    // The async socket-open IIFE has begun but not yet assigned wsRef, so
    // socketReadyState reads null. Without the connectInFlight guard this
    // would return true and double-connect.
    expect(
      shouldReconnectPtyOnPageResume({
        isActive: true,
        visibilityState: "visible",
        online: true,
        socketReadyState: null,
        ptyState: "connecting",
        connectInFlight: true,
      }),
    ).toBe(false);
  });

  it("still reconnects an in-flight connect when the page already believes it is closed", () => {
    // A stuck attempt the user is actively trying to recover (manual reconnect
    // or a closed state) must not be suppressed by the in-flight guard.
    expect(
      shouldReconnectPtyOnPageResume({
        isActive: true,
        visibilityState: "visible",
        online: true,
        socketReadyState: null,
        ptyState: "closed",
        connectInFlight: true,
      }),
    ).toBe(true);
  });
});

describe("shouldBlockPtyInput", () => {
  it("allows input only while the PTY socket is open", () => {
    expect(shouldBlockPtyInput("open")).toBe(false);
    expect(shouldBlockPtyInput("connecting")).toBe(true);
    expect(shouldBlockPtyInput("reconnecting")).toBe(true);
    expect(shouldBlockPtyInput("closed")).toBe(true);
    expect(shouldBlockPtyInput("ended")).toBe(true);
  });
});
