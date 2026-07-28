import { describe, expect, it } from "vitest";

import {
  planInitialWindow,
  planOlderPage,
} from "./chat-history-window";

describe("planInitialWindow", () => {
  it("takes the tail of a single large session and leaves a cursor", () => {
    const { fetches, cursor } = planInitialWindow([200], 60);
    expect(fetches).toEqual([{ chainIndex: 0, offset: 140, limit: 60 }]);
    expect(cursor).toEqual({ chainIndex: 0, offset: 140 });
  });

  it("loads everything when the session is smaller than a page", () => {
    const { fetches, cursor } = planInitialWindow([10], 60);
    expect(fetches).toEqual([{ chainIndex: 0, offset: 0, limit: 10 }]);
    expect(cursor).toBeNull();
  });

  it("spans a chain from newest backwards", () => {
    const { fetches, cursor } = planInitialWindow([100, 5, 20], 60);
    expect(fetches).toEqual([
      { chainIndex: 0, offset: 65, limit: 35 },
      { chainIndex: 1, offset: 0, limit: 5 },
      { chainIndex: 2, offset: 0, limit: 20 },
    ]);
    expect(cursor).toEqual({ chainIndex: 0, offset: 65 });
  });

  it("skips empty descendants and points the cursor at real content", () => {
    const { fetches, cursor } = planInitialWindow([80, 0, 0], 60);
    expect(fetches).toEqual([{ chainIndex: 0, offset: 20, limit: 60 }]);
    expect(cursor).toEqual({ chainIndex: 0, offset: 20 });
  });

  it("returns a null cursor at an exact page boundary", () => {
    const { cursor } = planInitialWindow([60], 60);
    expect(cursor).toBeNull();
  });
});

describe("planOlderPage", () => {
  it("pages backwards within a session", () => {
    const step = planOlderPage([200], { chainIndex: 0, offset: 140 }, 60);
    expect(step.fetch).toEqual({ chainIndex: 0, offset: 80, limit: 60 });
    expect(step.cursor).toEqual({ chainIndex: 0, offset: 80 });
  });

  it("crosses into the previous chain session when a session is drained", () => {
    const step = planOlderPage([30, 40], { chainIndex: 1, offset: 40 }, 60);
    expect(step.fetch).toEqual({ chainIndex: 1, offset: 0, limit: 40 });
    expect(step.cursor).toEqual({ chainIndex: 0, offset: 30 });
  });

  it("reports the beginning when the root drains", () => {
    const step = planOlderPage([25], { chainIndex: 0, offset: 25 }, 60);
    expect(step.fetch).toEqual({ chainIndex: 0, offset: 0, limit: 25 });
    expect(step.cursor).toBeNull();
  });
});
