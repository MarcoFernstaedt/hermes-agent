import { describe, expect, it } from "vitest";

import { parseEntityEvent } from "./entity-events";

describe("parseEntityEvent", () => {
  it("parses a valid entity frame (string or object)", () => {
    const frame = { kind: "entity", type: "job", id: "abc", action: "updated", version: 3, _seq: 7 };
    expect(parseEntityEvent(frame)).toEqual({
      type: "job",
      id: "abc",
      action: "updated",
      version: 3,
    });
    expect(parseEntityEvent(JSON.stringify(frame))).toEqual({
      type: "job",
      id: "abc",
      action: "updated",
      version: 3,
    });
  });

  it("defaults a missing version to 0", () => {
    expect(parseEntityEvent({ kind: "entity", type: "job", id: "a", action: "created" })?.version).toBe(0);
  });

  it("rejects non-entity, malformed, or unknown-action frames", () => {
    expect(parseEntityEvent({ kind: "chat", type: "job", id: "a", action: "created" })).toBeNull();
    expect(parseEntityEvent({ kind: "entity", type: "job", action: "created" })).toBeNull(); // no id
    expect(parseEntityEvent({ kind: "entity", type: "job", id: "a", action: "poked" })).toBeNull();
    expect(parseEntityEvent("not json")).toBeNull();
    expect(parseEntityEvent(null)).toBeNull();
  });
});
