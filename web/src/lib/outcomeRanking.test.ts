/**
 * Outcome ranking.
 *
 * The two failures worth guarding against pull opposite ways: a recommendation
 * with no stated reason, and an income gate that outranks a hospital
 * appointment. Most of these tests are one or the other.
 */
import { describe, expect, it } from "vitest";

import {
  WORK_STATE_LABEL,
  explainOutcome,
  rankOutcomes,
  scoreOutcome,
  workStateFor,
  type OutcomeCandidate,
} from "./outcomeRanking";

const NOW = new Date("2026-08-01T09:00:00Z");

function item(over: Partial<OutcomeCandidate> = {}): OutcomeCandidate {
  return {
    id: "a",
    title: "Something",
    source: "progress",
    consequence: "moderate",
    recovery: "days",
    ...over,
  };
}

describe("income never becomes the axis", () => {
  it("ranks a severe irrecoverable health item above an income task", () => {
    // The failure this is here for: a ranker tuned for runway puts an invoice
    // above an appointment that cannot be rebooked.
    const ranking = rankOutcomes(
      [
        item({ id: "invoice", source: "finance", consequence: "high", recovery: "days", income: true }),
        item({ id: "appointment", source: "health", consequence: "severe", recovery: "irrecoverable" }),
      ],
      { now: NOW },
    );
    expect(ranking.recommendedId).toBe("appointment");
  });

  it("still lets income break a tie between otherwise equal work", () => {
    const ranking = rankOutcomes(
      [
        item({ id: "paid", income: true }),
        item({ id: "unpaid" }),
      ],
      { now: NOW },
    );
    expect(ranking.recommendedId).toBe("paid");
  });

  it("weights income below consequence, recovery, deadline and commitment", () => {
    const base = item();
    const withIncome = scoreOutcome({ ...base, income: true }, NOW) - scoreOutcome(base, NOW);
    const withCommitment = scoreOutcome({ ...base, committed: true }, NOW) - scoreOutcome(base, NOW);
    const withLeverage = scoreOutcome({ ...base, leverage: true }, NOW) - scoreOutcome(base, NOW);
    expect(withIncome).toBeLessThan(withCommitment);
    expect(withIncome).toBeLessThan(withLeverage);
  });

  it("does not let an urgent non-income commitment be crowded out", () => {
    const ranking = rankOutcomes(
      [
        item({ id: "money1", income: true }),
        item({ id: "money2", income: true }),
        item({ id: "money3", income: true }),
        item({ id: "housing", source: "housing", consequence: "severe", recovery: "irrecoverable" }),
      ],
      { now: NOW },
    );
    expect(ranking.top.map((t) => t.id)).toContain("housing");
  });
});

describe("deadlines", () => {
  it("puts overdue above due-today", () => {
    const ranking = rankOutcomes(
      [
        item({ id: "today", dueAt: "2026-08-01T20:00:00Z" }),
        item({ id: "overdue", dueAt: "2026-07-30T09:00:00Z" }),
      ],
      { now: NOW },
    );
    expect(ranking.recommendedId).toBe("overdue");
  });

  it("treats nine days and thirty days alike", () => {
    // Both are "not today". Separating them would rank a distant deadline
    // above a same-day commitment that has no deadline at all.
    const nine = scoreOutcome(item({ dueAt: "2026-08-10T09:00:00Z" }), NOW);
    const thirty = scoreOutcome(item({ dueAt: "2026-08-31T09:00:00Z" }), NOW);
    expect(nine).toBe(thirty);
  });

  it("does not treat a missing deadline as urgent", () => {
    const withDeadline = scoreOutcome(item({ dueAt: "2026-08-01T20:00:00Z" }), NOW);
    expect(scoreOutcome(item(), NOW)).toBeLessThan(withDeadline);
  });

  it("ignores an unparseable date rather than ranking on NaN", () => {
    expect(scoreOutcome(item({ dueAt: "not a date" }), NOW)).toBe(scoreOutcome(item(), NOW));
  });
});

describe("every outcome says why", () => {
  it("never returns an empty explanation", () => {
    const ranking = rankOutcomes(
      [item({ id: "a" }), item({ id: "b", consequence: "low", recovery: "hours" })],
      { now: NOW },
    );
    expect(ranking.top.every((t) => t.why.trim().length > 0)).toBe(true);
  });

  it("names the factors that actually moved the score", () => {
    const why = explainOutcome(
      item({ consequence: "severe", recovery: "irrecoverable", committed: true }),
      NOW,
    );
    expect(why).toContain("consequence is severe");
    expect(why).toContain("cannot be recovered later");
    expect(why).toContain("you committed to it");
  });

  it("says where it came from, so the owner can check it", () => {
    expect(explainOutcome(item({ source: "calendar" }), NOW)).toContain("Calendar");
    expect(explainOutcome(item({ source: "gmail" }), NOW)).toContain("Gmail");
  });

  it("admits when nothing about an item is urgent", () => {
    const why = explainOutcome(item({ consequence: "low", recovery: "hours" }), NOW);
    expect(why).toContain("Nothing about it is urgent");
  });

  it("reads as a sentence rather than a list of tokens", () => {
    const why = explainOutcome(item({ consequence: "severe", committed: true, leverage: true }), NOW);
    expect(why).toMatch(/ and /);
    expect(why.endsWith(".")).toBe(true);
  });
});

describe("the recommendation", () => {
  it("marks exactly one item", () => {
    const ranking = rankOutcomes([item({ id: "a" }), item({ id: "b" }), item({ id: "c" })], {
      now: NOW,
    });
    expect(ranking.top.filter((t) => t.recommended)).toHaveLength(1);
  });

  it("returns at most three", () => {
    const many = Array.from({ length: 9 }, (_, i) => item({ id: `i${i}` }));
    expect(rankOutcomes(many, { now: NOW }).top).toHaveLength(3);
  });

  it("reports how many it considered, so the UI can say three of nine", () => {
    const many = Array.from({ length: 9 }, (_, i) => item({ id: `i${i}` }));
    expect(rankOutcomes(many, { now: NOW }).consideredCount).toBe(9);
  });

  it("has nothing to recommend when there is nothing to do", () => {
    const ranking = rankOutcomes([], { now: NOW });
    expect(ranking.recommendedId).toBeNull();
    expect(ranking.top).toEqual([]);
  });

  it("orders identically across two calls on the same state", () => {
    // Equal scores must not shuffle between renders.
    const items = [item({ id: "b" }), item({ id: "a" }), item({ id: "c" })];
    const first = rankOutcomes(items, { now: NOW }).top.map((t) => t.id);
    const second = rankOutcomes([...items].reverse(), { now: NOW }).top.map((t) => t.id);
    expect(first).toEqual(second);
  });
});

describe("Marco's override beats the score", () => {
  it("replaces the recommendation outright", () => {
    const ranking = rankOutcomes(
      [
        item({ id: "scored-first", consequence: "severe", recovery: "irrecoverable" }),
        item({ id: "chosen", consequence: "low", recovery: "hours" }),
      ],
      { now: NOW, overrideId: "chosen" },
    );
    expect(ranking.recommendedId).toBe("chosen");
    expect(ranking.top.find((t) => t.recommended)?.id).toBe("chosen");
  });

  it("pulls the override into view even when it scored outside the top three", () => {
    // A recommendation the owner cannot see is not a recommendation.
    const items = [
      ...Array.from({ length: 5 }, (_, i) =>
        item({ id: `high${i}`, consequence: "severe", recovery: "irrecoverable" }),
      ),
      item({ id: "chosen", consequence: "low", recovery: "hours" }),
    ];
    const ranking = rankOutcomes(items, { now: NOW, overrideId: "chosen" });
    expect(ranking.top[0].id).toBe("chosen");
    expect(ranking.top).toHaveLength(3);
  });

  it("keeps the override's own explanation rather than inventing one", () => {
    const ranking = rankOutcomes(
      [item({ id: "chosen", source: "housing", consequence: "severe" })],
      { now: NOW, overrideId: "chosen" },
    );
    expect(ranking.top[0].why).toContain("Housing");
  });

  it("ignores an override naming something that no longer exists", () => {
    // Obeying it would leave the page with no recommendation at all.
    const ranking = rankOutcomes([item({ id: "a" })], { now: NOW, overrideId: "deleted" });
    expect(ranking.recommendedId).toBe("a");
  });
});

describe("provenance", () => {
  it("carries the source through ranking, so nothing is unattributable", () => {
    const ranking = rankOutcomes(
      [item({ id: "a", source: "calendar" }), item({ id: "b", source: "jobs" })],
      { now: NOW },
    );
    expect(ranking.top.map((t) => t.source).sort()).toEqual(["calendar", "jobs"]);
  });
});

describe("work state", () => {
  it("waits for the owner when the work is not internally safe", () => {
    expect(workStateFor(item({ safeToStart: false }))).toBe("awaiting_you");
  });

  it("is startable when the work is internal and reversible", () => {
    expect(workStateFor(item({ safeToStart: true }))).toBe("not_started");
  });

  it("reports a pending approval above everything else", () => {
    // Even work marked safe: an approval in flight is the true state.
    expect(
      workStateFor(item({ safeToStart: true }), { started: true, approvalPending: true }),
    ).toBe("blocked_by_approval");
  });

  it("says plainly when Imperator is already working", () => {
    expect(workStateFor(item({ safeToStart: true }), { started: true })).toBe("running");
  });

  it("has words for every state, not a colour", () => {
    for (const state of Object.keys(WORK_STATE_LABEL)) {
      expect(WORK_STATE_LABEL[state as keyof typeof WORK_STATE_LABEL]).toBeTruthy();
    }
    expect(WORK_STATE_LABEL.blocked_by_approval).toContain("approval");
  });
});
