/**
 * Now's reading order.
 *
 * For a screen-reader user the reading order is the design, so it is asserted
 * here rather than left implied by JSX nesting — where a later layout refactor
 * could change what Marco hears first with nothing to notice.
 */
import { describe, expect, it } from "vitest";

import {
  NOW_SECTION_ORDER,
  gateSentence,
  nowSections,
  systemStateSentence,
  visibleSections,
  type NowContent,
} from "./nowOrder";

const full: NowContent = {
  outcome: "Ship the packet",
  routines: { completed: 2, total: 3 },
  incomeGate: { met: false, label: "Daily income gate" },
  commitment: { title: "Call with Dana", startsAt: "2026-08-01T15:00:00Z" },
  application: { title: "Reply from Acme", state: "reply" },
  exception: { summary: "Home Assistant has no token", actionRequired: true },
};

describe("reading order", () => {
  it("puts the day's outcome ahead of everything except the page state", () => {
    const ids = visibleSections(full).map((s) => s.id);
    expect(ids[0]).toBe("heading");
    expect(ids[1]).toBe("outcome");
  });

  it("reads in the specified order with everything present", () => {
    expect(visibleSections(full).map((s) => s.id)).toEqual([
      "heading",
      "outcome",
      "gate",
      "commitment",
      "application",
      "exception",
      "ask",
      "links",
    ]);
  });

  it("puts Ask Imperator after the day's content, not before it", () => {
    // The prompt is the way to act on what was just read; above the content it
    // would be a search box on an empty page.
    const ids = visibleSections(full).map((s) => s.id);
    expect(ids.indexOf("ask")).toBeGreaterThan(ids.indexOf("outcome"));
    expect(ids.indexOf("ask")).toBeGreaterThan(ids.indexOf("commitment"));
  });

  it("puts secondary links last", () => {
    const ids = visibleSections(full).map((s) => s.id);
    expect(ids[ids.length - 1]).toBe("links");
  });

  it("keeps the declared order stable", () => {
    // A guard against a reorder that looks harmless in a diff.
    expect([...NOW_SECTION_ORDER]).toEqual([
      "heading", "outcome", "gate", "commitment",
      "application", "exception", "ask", "links",
    ]);
  });
});

describe("absent is absent, not empty", () => {
  it("renders nothing for a day with no content beyond the shell", () => {
    expect(visibleSections({}).map((s) => s.id)).toEqual(["heading", "ask", "links"]);
  });

  it("drops the outcome section when no outcome is chosen", () => {
    const ids = visibleSections({ ...full, outcome: null }).map((s) => s.id);
    expect(ids).not.toContain("outcome");
  });

  it("treats a whitespace outcome as no outcome", () => {
    expect(visibleSections({ outcome: "   " }).map((s) => s.id)).not.toContain("outcome");
  });

  it("drops applications entirely when Marco has entered none", () => {
    // There is no sourcing: no application means no section, not an invitation
    // to go find some.
    const ids = visibleSections({ ...full, application: null }).map((s) => s.id);
    expect(ids).not.toContain("application");
  });

  it("still names every section it knows about, for the page to skip", () => {
    // `nowSections` reports all of them with a flag; `visibleSections` filters.
    expect(nowSections({}).length).toBe(NOW_SECTION_ORDER.length);
    expect(nowSections({}).every((s) => s.heading)).toBe(true);
  });
});

describe("exceptions only when something must be done", () => {
  it("shows an exception that requires action", () => {
    expect(visibleSections(full).map((s) => s.id)).toContain("exception");
  });

  it("hides a degradation the owner cannot act on", () => {
    // A status above the thing they came for, that they can do nothing about,
    // is noise — and it trains them to skip the region that will one day
    // matter.
    const content = {
      ...full,
      exception: { summary: "Cache warming", actionRequired: false },
    };
    expect(visibleSections(content).map((s) => s.id)).not.toContain("exception");
  });

  it("puts the exception below the day's content, not above it", () => {
    const ids = visibleSections(full).map((s) => s.id);
    expect(ids.indexOf("exception")).toBeGreaterThan(ids.indexOf("outcome"));
  });
});

describe("system state sentence", () => {
  it("says the plain thing when all is well", () => {
    expect(
      systemStateSentence({ capabilitiesNeedingAttention: 0, chatReachable: true }),
    ).toBe("Imperator is running.");
  });

  it("leads with unreachability, because nothing else matters then", () => {
    expect(
      systemStateSentence({ capabilitiesNeedingAttention: 3, chatReachable: false }),
    ).toBe("Imperator is not reachable right now.");
  });

  it("counts connections needing attention, and agrees with itself", () => {
    expect(
      systemStateSentence({ capabilitiesNeedingAttention: 1, chatReachable: true }),
    ).toContain("One connection needs attention");
    expect(
      systemStateSentence({ capabilitiesNeedingAttention: 4, chatReachable: true }),
    ).toContain("4 connections need attention");
  });
});

describe("the routine and income line", () => {
  it("reads as a sentence, not a ratio glyph", () => {
    expect(gateSentence(full)).toBe("2 of 3 routines done. Daily income gate not met yet.");
  });

  it("says all done rather than 3 of 3", () => {
    expect(gateSentence({ routines: { completed: 3, total: 3 } })).toBe(
      "All 3 routines done.",
    );
  });

  it("returns nothing when there is nothing to report", () => {
    // So the caller renders nothing, rather than a zero that looks like a
    // failure to complete routines that were never set.
    expect(gateSentence({})).toBeNull();
  });

  it("reports an income gate on its own", () => {
    expect(gateSentence({ incomeGate: { met: true, label: "Daily income gate" } })).toBe(
      "Daily income gate met.",
    );
  });
});
