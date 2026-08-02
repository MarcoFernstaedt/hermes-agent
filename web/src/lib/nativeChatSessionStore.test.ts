// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearDurableSessionId,
  loadDurableSessionId,
  saveDurableSessionId,
} from "./nativeChatSessionStore";

describe("durable session persistence", () => {
  beforeEach(() => window.localStorage.clear());

  it("round-trips the durable id", () => {
    saveDurableSessionId("durable-1");
    expect(loadDurableSessionId()).toBe("durable-1");
  });

  it("keeps profiles apart", () => {
    // Two profiles are two conversations over two state databases. Resuming
    // A's session under B would either fail or, worse, show the wrong history.
    saveDurableSessionId("a-session", "work");
    saveDurableSessionId("b-session", "personal");
    expect(loadDurableSessionId("work")).toBe("a-session");
    expect(loadDurableSessionId("personal")).toBe("b-session");
    expect(loadDurableSessionId("unknown")).toBeNull();
  });

  it("reports nothing to resume when empty or blank", () => {
    expect(loadDurableSessionId()).toBeNull();
    saveDurableSessionId("   ");
    expect(loadDurableSessionId()).toBeNull();
  });

  it("clears", () => {
    saveDurableSessionId("gone-soon");
    clearDurableSessionId();
    expect(loadDurableSessionId()).toBeNull();
  });

  it("uses localStorage so the session outlives the tab", () => {
    // sessionStorage would defeat the point: reopening the dashboard should
    // find the conversation where it was left.
    saveDurableSessionId("durable-1");
    expect(Object.keys(localStorage).some((k) => k.includes("nativeChat.session"))).toBe(true);
    expect(Object.keys(sessionStorage)).toHaveLength(0);
  });

  it("degrades to no persistence when storage is unavailable", () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    // Chat still works; it simply creates a fresh session each load.
    expect(() => saveDurableSessionId("x")).not.toThrow();
    expect(loadDurableSessionId()).toBeNull();
    get.mockRestore();
    set.mockRestore();
  });
});
