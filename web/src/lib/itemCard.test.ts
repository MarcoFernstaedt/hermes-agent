import { describe, expect, it } from "vitest";

import {
  batchSummary,
  canDecide,
  cardPhase,
  decisionTargetsCurrentVersion,
  describeChanges,
  groupForBatch,
  hasVerdictFacts,
  isIrreversible,
  permanenceSentence,
  statusSentence,
  verdictFacts,
  type BatchableItem,
  type Permanence,
} from "./itemCard";
import { State } from "./itemState";

describe("cardPhase", () => {
  it("keeps deciding and done apart", () => {
    // The whole reason the lifecycle was reworked: an approved item is not a
    // finished one, and the card must not let it look finished.
    expect(cardPhase(State.APPROVED)).toBe("working");
    expect(cardPhase(State.SUCCEEDED)).toBe("done");
  });

  it("treats queued and executing as work in progress", () => {
    expect(cardPhase(State.QUEUED)).toBe("working");
    expect(cardPhase(State.EXECUTING)).toBe("working");
  });

  it("surfaces failures and failed reversals as needing attention", () => {
    expect(cardPhase(State.FAILED)).toBe("attention");
    expect(cardPhase(State.COMPENSATION_FAILED)).toBe("attention");
  });

  it("closes out the resolved-and-quiet states", () => {
    for (const s of [State.DENIED, State.EXPIRED, State.CANCELED, State.COMPENSATED]) {
      expect(cardPhase(s), s).toBe("closed");
    }
  });

  it("falls back to deciding for a state it does not know", () => {
    // Better to offer the buttons than to render a dead card.
    expect(cardPhase("something_new")).toBe("deciding");
  });
});

describe("canDecide", () => {
  it("offers buttons only while a decision is actually open", () => {
    expect(canDecide(State.AWAITING_DECISION)).toBe(true);
    expect(canDecide(State.OPEN)).toBe(true);
  });

  it("withholds them once the item has moved on", () => {
    for (const s of [State.APPROVED, State.EXECUTING, State.SUCCEEDED, State.DENIED, State.SNOOZED]) {
      expect(canDecide(s), s).toBe(false);
    }
  });
});

describe("statusSentence", () => {
  it("never lets approval read as completion", () => {
    expect(statusSentence({ state: State.APPROVED })).toBe("Approved — not started yet.");
  });

  it("counts retries so a silent second attempt is visible", () => {
    expect(statusSentence({ state: State.EXECUTING, attempt: 2 })).toContain("attempt 2");
    expect(statusSentence({ state: State.EXECUTING, attempt: 1 })).toBe("Running…");
  });

  it("carries the outcome into done and failed", () => {
    expect(statusSentence({ state: State.SUCCEEDED, outcome: "Sent to a@b.c" })).toContain(
      "Sent to a@b.c",
    );
    expect(statusSentence({ state: State.FAILED, outcome: "smtp timeout" })).toContain(
      "smtp timeout",
    );
  });

  it("shows the denial reason back to the owner", () => {
    expect(statusSentence({ state: State.DENIED, reason: "wrong recipient" })).toBe(
      "Denied — wrong recipient",
    );
  });

  it("says plainly when a reversal failed", () => {
    expect(statusSentence({ state: State.COMPENSATION_FAILED })).toContain("needs you");
  });
});

describe("permanence", () => {
  it("does not let a compensation claim to be an undo", () => {
    // A best-effort reversal against an external system is a different promise
    // from a transactional inverse, and conflating them makes the card lie
    // about what approval costs.
    expect(permanenceSentence("inverse")).toBe("This can be undone.");
    expect(permanenceSentence("compensation")).toContain("not guaranteed");
    expect(permanenceSentence("compensation")).not.toBe("This can be undone.");
  });

  it("treats unknown reversibility as permanent", () => {
    expect(isIrreversible("unknown")).toBe(true);
    expect(permanenceSentence("unknown")).toContain("treat as permanent");
  });

  it("states irreversibility without hedging", () => {
    expect(permanenceSentence("irreversible")).toBe("This cannot be undone.");
    expect(isIrreversible("irreversible")).toBe(true);
  });

  it("does not call a reversible action permanent", () => {
    expect(isIrreversible("inverse")).toBe(false);
    expect(isIrreversible("compensation")).toBe(false);
  });
});

describe("verdictFacts", () => {
  it("returns only what actually exists", () => {
    const f = verdictFacts({ verdict: "APPROVE", description: "rm in a script" });
    expect(f).toEqual({ verdict: "APPROVE", trigger: "rm in a script" });
  });

  it("reports nothing at all when there was no review", () => {
    // A placeholder would invite the reader to assume a review happened.
    expect(hasVerdictFacts(verdictFacts({}))).toBe(false);
    expect(hasVerdictFacts(verdictFacts({ verdict: "   " }))).toBe(false);
  });

  it("accepts either spelling of the gate trigger", () => {
    expect(verdictFacts({ trigger: "sudo" }).trigger).toBe("sudo");
    expect(verdictFacts({ description: "sudo" }).trigger).toBe("sudo");
  });

  it("ignores non-string junk rather than rendering it", () => {
    expect(verdictFacts({ verdict: 42, tier: null })).toEqual({});
  });
});

describe("groupForBatch", () => {
  const item = (over: Partial<BatchableItem>): BatchableItem => ({
    id: Math.random().toString(36).slice(2),
    actionId: "mail.archive",
    source: "gmail",
    consequence: "external_reversible",
    permanence: "compensation" as Permanence,
    title: "Archive something",
    ...over,
  });

  it("groups identical reversible actions", () => {
    const { groups, ungrouped } = groupForBatch([item({}), item({}), item({})]);
    expect(groups).toHaveLength(1);
    expect(groups[0].items).toHaveLength(3);
    expect(ungrouped).toHaveLength(0);
  });

  it("never groups across consequence classes", () => {
    // An archive and a send are not one decision no matter how alike they look.
    const { groups } = groupForBatch([
      item({ consequence: "internal_reversible" }),
      item({ consequence: "external_reversible" }),
    ]);
    expect(groups).toHaveLength(0);
  });

  it("never groups across permanence", () => {
    const { groups } = groupForBatch([
      item({ permanence: "inverse" }),
      item({ permanence: "compensation" }),
    ]);
    expect(groups).toHaveLength(0);
  });

  it("never batches an irreversible action at all", () => {
    // The convenience of approving twelve at once is not worth one unread send.
    const { groups, ungrouped } = groupForBatch([
      item({ actionId: "mail.send", permanence: "irreversible" }),
      item({ actionId: "mail.send", permanence: "irreversible" }),
    ]);
    expect(groups).toHaveLength(0);
    expect(ungrouped).toHaveLength(2);
  });

  it("treats unknown permanence as unbatchable", () => {
    const { groups } = groupForBatch([
      item({ permanence: "unknown" }),
      item({ permanence: "unknown" }),
    ]);
    expect(groups).toHaveLength(0);
  });

  it("does not group across sources", () => {
    const { groups } = groupForBatch([item({ source: "gmail" }), item({ source: "outlook" })]);
    expect(groups).toHaveLength(0);
  });

  it("leaves a lone item alone rather than making a group of one", () => {
    const { groups, ungrouped } = groupForBatch([item({})]);
    expect(groups).toHaveLength(0);
    expect(ungrouped).toHaveLength(1);
  });

  it("summarises a group readably", () => {
    const { groups } = groupForBatch([item({}), item({})]);
    expect(batchSummary(groups[0])).toBe("2 to archive");
  });
});

describe("modify", () => {
  const v1 = { version: 1, text: "Dear Bob", payloadHash: "h1" };

  it("refuses to apply a decision to a version the owner is not reading", () => {
    // Otherwise they read v2 and authorise v1.
    const v2 = { version: 2, text: "Dear Robert", payloadHash: "h2" };
    expect(decisionTargetsCurrentVersion(v1, v2)).toBe(false);
    expect(decisionTargetsCurrentVersion(v2, v2)).toBe(true);
  });

  it("catches a hash change even when the version number did not move", () => {
    expect(decisionTargetsCurrentVersion(v1, { ...v1, payloadHash: "other" })).toBe(false);
  });

  it("counts changes rather than dumping a diff", () => {
    expect(describeChanges("a\nb\nc", "a\nB\nc")).toBe("1 change.");
    expect(describeChanges("a\nb\nc", "a\nB\nC")).toBe("2 changes.");
    expect(describeChanges("same", "same")).toBe("No changes.");
  });

  it("counts added and removed lines", () => {
    expect(describeChanges("a", "a\nb")).toBe("1 change.");
  });
});
