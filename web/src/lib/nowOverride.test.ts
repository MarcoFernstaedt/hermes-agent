// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import {
  readStoredOverride,
  resolveOverride,
  today,
  writeStoredOverride,
} from "./nowOverride";

describe("resolveOverride", () => {
  /**
   * The override was `useState(null)`, so it lasted exactly as long as the
   * component: a refresh, a trip to Progress and back, or the tab being
   * restored from the background all silently reinstated Imperator's
   * suggestion. The owner made a decision, the page acknowledged it, and then
   * reversed it when they were not looking.
   */
  it("keeps today's choice when the candidate is still there", () => {
    expect(
      resolveOverride(
        { day: "2026-08-01", id: "job:7" },
        { day: "2026-08-01", candidateIds: ["job:7", "review:a"] },
      ),
    ).toBe("job:7");
  });

  it("drops a choice made on an earlier day", () => {
    // "Start with this instead" is a statement about today. Carrying it into
    // tomorrow resurrects a decision about work that may be finished, at the
    // moment the owner least expects the page to be opinionated.
    expect(
      resolveOverride(
        { day: "2026-07-31", id: "job:7" },
        { day: "2026-08-01", candidateIds: ["job:7"] },
      ),
    ).toBeNull();
  });

  it("drops a choice whose candidate has since gone", () => {
    // The review item was answered, the packet was sent. An override pointing
    // at nothing must not keep suppressing the suggestion for what is left.
    expect(
      resolveOverride(
        { day: "2026-08-01", id: "review:answered" },
        { day: "2026-08-01", candidateIds: ["job:7"] },
      ),
    ).toBeNull();
  });

  it("is null when nothing was stored", () => {
    expect(resolveOverride(null, { day: "2026-08-01", candidateIds: ["a"] })).toBeNull();
  });
});

describe("storage", () => {
  beforeEach(() => window.localStorage.clear());

  it("survives a reload", () => {
    writeStoredOverride("job:7", "2026-08-01");
    expect(readStoredOverride()).toEqual({ day: "2026-08-01", id: "job:7" });
  });

  it("clearing removes it rather than storing a null", () => {
    writeStoredOverride("job:7", "2026-08-01");
    writeStoredOverride(null);
    expect(readStoredOverride()).toBeNull();
  });

  it("ignores a value someone else wrote", () => {
    window.localStorage.setItem("imperator.now.override", "not json");
    expect(readStoredOverride()).toBeNull();
    window.localStorage.setItem("imperator.now.override", JSON.stringify({ id: 7 }));
    expect(readStoredOverride()).toBeNull();
  });

  it("records the local day, which is the unit the owner thinks in", () => {
    // Not UTC: an override made at 9pm in UTC+2 is about that evening, not
    // about the next morning.
    const evening = new Date("2026-08-01T21:30:00Z");
    expect(today(evening)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
