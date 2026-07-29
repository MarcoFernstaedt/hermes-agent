// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import {
  APP_INTENT_EVENT,
  emitIntent,
  peekIntentLatch,
  type LatchedIntent,
} from "./app-intent";

describe("app-intent", () => {
  it("latches the most recent intent with a monotonic id", () => {
    emitIntent("email:compose");
    const first = peekIntentLatch();
    expect(first?.name).toBe("email:compose");

    emitIntent("vault:new-note", { path: "x" });
    const second = peekIntentLatch();
    expect(second?.name).toBe("vault:new-note");
    expect(second?.detail).toEqual({ path: "x" });
    expect(second!.id).toBeGreaterThan(first!.id);
  });

  it("dispatches a live event carrying the latched intent", () => {
    const received: LatchedIntent[] = [];
    const handler = (e: Event) => {
      received.push((e as CustomEvent<LatchedIntent>).detail);
    };
    window.addEventListener(APP_INTENT_EVENT, handler);
    emitIntent("calendar:new-event");
    window.removeEventListener(APP_INTENT_EVENT, handler);

    expect(received).toHaveLength(1);
    expect(received[0].name).toBe("calendar:new-event");
  });
});
