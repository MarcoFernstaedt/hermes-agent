import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./resilient-event-socket", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("./resilient-event-socket")>();
  return {
    ...original,
    connectResilientEventSocket: vi.fn(),
  };
});

vi.mock("./api", () => ({
  api: { buildWsUrl: vi.fn(async () => "ws://test/api/events") },
}));

import { connectResilientEventSocket } from "./resilient-event-socket";
import type { ResilientEventSocketOptions } from "./resilient-event-socket";
import {
  _resetDashboardEventHub,
  restartDashboardEvents,
  subscribeDashboardEvents,
  type DashboardEventListener,
} from "./event-channel-hub";

const connectMock = vi.mocked(connectResilientEventSocket);

/** Captured options + stop spy for each socket the hub opened. */
let sockets: Array<{ options: ResilientEventSocketOptions; stop: ReturnType<typeof vi.fn> }>;

function makeListener(): DashboardEventListener & {
  messages: unknown[];
  connects: boolean[];
  disconnects: Array<number | null>;
  terminals: unknown[];
} {
  const record = {
    messages: [] as unknown[],
    connects: [] as boolean[],
    disconnects: [] as Array<number | null>,
    terminals: [] as unknown[],
    onMessage(event: MessageEvent) {
      record.messages.push(event.data);
    },
    onConnected(reconnected: boolean) {
      record.connects.push(reconnected);
    },
    onDisconnected(code: number | null) {
      record.disconnects.push(code);
    },
    onTerminalFailure(failure: unknown) {
      record.terminals.push(failure);
    },
  };
  return record;
}

beforeEach(() => {
  sockets = [];
  connectMock.mockReset();
  connectMock.mockImplementation((options: ResilientEventSocketOptions) => {
    const stop = vi.fn();
    sockets.push({ options, stop });
    return stop;
  });
});

afterEach(() => {
  _resetDashboardEventHub();
});

describe("event-channel-hub", () => {
  it("shares one socket between subscribers on the same channel", () => {
    const a = makeListener();
    const b = makeListener();
    subscribeDashboardEvents("chan-1", a);
    subscribeDashboardEvents("chan-1", b);

    expect(connectMock).toHaveBeenCalledTimes(1);

    sockets[0].options.onMessage({ data: "frame-1" } as MessageEvent);
    expect(a.messages).toEqual(["frame-1"]);
    expect(b.messages).toEqual(["frame-1"]);
  });

  it("opens separate sockets per channel", () => {
    subscribeDashboardEvents("chan-1", makeListener());
    subscribeDashboardEvents("chan-2", makeListener());
    expect(connectMock).toHaveBeenCalledTimes(2);
  });

  it("closes the socket only when the last subscriber leaves", () => {
    const offA = subscribeDashboardEvents("chan-1", makeListener());
    const offB = subscribeDashboardEvents("chan-1", makeListener());

    offA();
    expect(sockets[0].stop).not.toHaveBeenCalled();
    offB();
    expect(sockets[0].stop).toHaveBeenCalledTimes(1);

    // A fresh subscribe after teardown opens a new socket.
    subscribeDashboardEvents("chan-1", makeListener());
    expect(connectMock).toHaveBeenCalledTimes(2);
  });

  it("tells late joiners the socket is already connected", () => {
    subscribeDashboardEvents("chan-1", makeListener());
    sockets[0].options.onConnected(false);

    const late = makeListener();
    subscribeDashboardEvents("chan-1", late);
    expect(late.connects).toEqual([false]);
  });

  it("tells late joiners about an existing terminal failure", () => {
    subscribeDashboardEvents("chan-1", makeListener());
    sockets[0].options.onTerminalFailure?.({ code: 4401, error: null });

    const late = makeListener();
    subscribeDashboardEvents("chan-1", late);
    expect(late.terminals).toEqual([{ code: 4401, error: null }]);
  });

  it("fans out disconnect and reconnect transitions to every listener", () => {
    const a = makeListener();
    const b = makeListener();
    subscribeDashboardEvents("chan-1", a);
    subscribeDashboardEvents("chan-1", b);

    sockets[0].options.onConnected(false);
    sockets[0].options.onDisconnected(1006);
    sockets[0].options.onConnected(true);

    expect(a.connects).toEqual([false, true]);
    expect(b.connects).toEqual([false, true]);
    expect(a.disconnects).toEqual([1006]);
    expect(b.disconnects).toEqual([1006]);
  });

  it("restart opens a fresh socket and carries listeners over", () => {
    const a = makeListener();
    const off = subscribeDashboardEvents("chan-1", a);
    sockets[0].options.onTerminalFailure?.({ code: 4401, error: null });

    restartDashboardEvents("chan-1");
    expect(sockets[0].stop).toHaveBeenCalledTimes(1);
    expect(connectMock).toHaveBeenCalledTimes(2);

    // The carried listener still receives from the new socket.
    sockets[1].options.onMessage({ data: "after-restart" } as MessageEvent);
    expect(a.messages).toEqual(["after-restart"]);

    // Unsubscribing the carried listener tears the new socket down.
    off();
    expect(sockets[1].stop).toHaveBeenCalledTimes(1);
  });
});
