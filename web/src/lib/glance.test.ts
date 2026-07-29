import { describe, expect, it } from "vitest";

import { deriveGlance, glanceTone, shouldAnnounce, type GlanceInput } from "./glance";

function input(over: Partial<GlanceInput> = {}): GlanceInput {
  return { blockingCount: 0, activity: "idle", problems: [], ...over };
}

describe("deriveGlance", () => {
  it("answers all three questions in one sentence", () => {
    const g = deriveGlance(input({ blockingCount: 2, activity: "thinking", problems: ["Pi unreachable"] }));
    expect(g.announcement).toBe(
      "2 items waiting on you. Imperator is thinking. Pi unreachable.",
    );
  });

  it("says the tool by name when one is running", () => {
    const g = deriveGlance(input({ activity: "tool", toolName: "web_search" }));
    expect(g.announcement).toContain("running web_search");
    expect(g.activityLabel).toBe("web_search");
  });

  it("singularises one waiting item", () => {
    expect(deriveGlance(input({ blockingCount: 1 })).announcement).toContain("1 item waiting");
  });

  it("summarises several problems rather than reading them all", () => {
    const g = deriveGlance(input({ problems: ["a", "b", "c"] }));
    expect(g.announcement).toContain("3 systems degraded");
  });

  it("ignores blank problems", () => {
    expect(deriveGlance(input({ problems: ["  ", ""] })).degraded).toBe(false);
  });

  it("never reports a negative or fractional count", () => {
    expect(deriveGlance(input({ blockingCount: -3 })).blockingCount).toBe(0);
    expect(deriveGlance(input({ blockingCount: 2.7 })).blockingCount).toBe(2);
  });

  it("treats waiting as needing attention even with nothing queued", () => {
    expect(deriveGlance(input({ activity: "waiting" })).needsAttention).toBe(true);
  });

  it("treats offline and faulted as degraded", () => {
    expect(deriveGlance(input({ activity: "offline" })).degraded).toBe(true);
    expect(deriveGlance(input({ activity: "faulted" })).degraded).toBe(true);
  });
});

describe("shouldAnnounce", () => {
  const idle = deriveGlance(input());

  it("stays silent on first render", () => {
    // Announcing current state on page load talks over whatever the user did
    // to get here.
    expect(shouldAnnounce(null, idle)).toBe(false);
  });

  it("does not narrate the churn of a turn in flight", () => {
    // This is the rule that keeps the app usable by screen reader: thinking →
    // streaming → tool → streaming fires constantly during one normal reply.
    const thinking = deriveGlance(input({ activity: "thinking" }));
    const streaming = deriveGlance(input({ activity: "streaming" }));
    const tool = deriveGlance(input({ activity: "tool", toolName: "read_file" }));

    expect(shouldAnnounce(thinking, streaming)).toBe(false);
    expect(shouldAnnounce(streaming, tool)).toBe(false);
    expect(shouldAnnounce(tool, streaming)).toBe(false);
  });

  it("announces when the agent starts needing something", () => {
    const streaming = deriveGlance(input({ activity: "streaming" }));
    const waiting = deriveGlance(input({ activity: "waiting" }));
    expect(shouldAnnounce(streaming, waiting)).toBe(true);
  });

  it("announces when a turn ends", () => {
    const streaming = deriveGlance(input({ activity: "streaming" }));
    expect(shouldAnnounce(streaming, deriveGlance(input({ activity: "idle" })))).toBe(true);
  });

  it("announces going offline and coming back", () => {
    const online = deriveGlance(input({ activity: "idle" }));
    const offline = deriveGlance(input({ activity: "offline" }));
    expect(shouldAnnounce(online, offline)).toBe(true);
    expect(shouldAnnounce(offline, online)).toBe(true);
  });

  it("announces a change in what is waiting", () => {
    const none = deriveGlance(input({ blockingCount: 0 }));
    const one = deriveGlance(input({ blockingCount: 1 }));
    expect(shouldAnnounce(none, one)).toBe(true);
    expect(shouldAnnounce(one, none)).toBe(true);
  });

  it("announces a degradation appearing or clearing", () => {
    const ok = deriveGlance(input());
    const bad = deriveGlance(input({ problems: ["VPS unreachable"] }));
    expect(shouldAnnounce(ok, bad)).toBe(true);
    expect(shouldAnnounce(bad, ok)).toBe(true);
  });

  it("says nothing when nothing changed", () => {
    expect(shouldAnnounce(idle, deriveGlance(input()))).toBe(false);
  });

  it("does not re-announce a tool change within the same activity", () => {
    const a = deriveGlance(input({ activity: "tool", toolName: "read_file" }));
    const b = deriveGlance(input({ activity: "tool", toolName: "web_search" }));
    expect(shouldAnnounce(a, b)).toBe(false);
  });
});

describe("glanceTone", () => {
  it("gives attention precedence over everything", () => {
    const g = deriveGlance(input({ blockingCount: 1, problems: ["x"], activity: "streaming" }));
    expect(glanceTone(g)).toBe("attention");
  });

  it("reports degraded when nothing needs a decision", () => {
    expect(glanceTone(deriveGlance(input({ problems: ["x"] })))).toBe("degraded");
  });

  it("reports working during a turn", () => {
    expect(glanceTone(deriveGlance(input({ activity: "streaming" })))).toBe("working");
  });

  it("is calm when idle and healthy", () => {
    expect(glanceTone(deriveGlance(input()))).toBe("calm");
  });
});
