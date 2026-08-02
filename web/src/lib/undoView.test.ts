import { describe, expect, it } from "vitest";

import { describeEntry, describeOutcome, sectionsFor } from "./undoView";
import type { UndoApplyResult, UndoEntry, UndoSummary } from "@/lib/api";

function entry(over: Partial<UndoEntry> = {}): UndoEntry {
  return {
    id: "e1",
    action: "vault.write",
    actor: "agent",
    session_id: "s1",
    target: "note.md",
    status: "done",
    rollback: "inverse",
    rollback_detail: "vault.restore",
    outcome: "",
    created_at: 1,
    claimed_at: null,
    undone_at: null,
    reversible: true,
    needs_repair: false,
    in_flight: false,
    creates_note: false,
    permanence: "",
    ...over,
  };
}

function summary(over: Partial<UndoSummary> = {}): UndoSummary {
  const merged = {
    stack: [] as UndoEntry[],
    repairs: [] as UndoEntry[],
    in_flight: [] as UndoEntry[],
    ...over,
  };
  return {
    ...merged,
    counts: {
      stack: merged.stack.length,
      repairs: merged.repairs.length,
      in_flight: merged.in_flight.length,
    },
  };
}

/**
 * Which sections appear and in what order is the point of the undo screen, not
 * decoration — so it lives here rather than inline in JSX where a layout
 * change can quietly reshuffle it.
 */
describe("sectionsFor", () => {
  it("always shows the stack, so 'nothing to undo' is sayable", () => {
    const sections = sectionsFor(summary());
    expect(sections.map((s) => s.key)).toEqual(["stack"]);
    expect(sections[0].entries).toEqual([]);
  });

  it("puts what needs attention above everything else", () => {
    // These mean a reversal failed, or nobody knows whether it took effect.
    // Below a list of successful undos is how they go unnoticed for a week.
    const sections = sectionsFor(
      summary({
        stack: [entry({ id: "ok" })],
        in_flight: [entry({ id: "running", in_flight: true })],
        repairs: [entry({ id: "bad", needs_repair: true })],
      }),
    );
    expect(sections.map((s) => s.key)).toEqual(["repairs", "in_flight", "stack"]);
  });

  it("keeps an in-progress reversal out of both other lists", () => {
    // Claimed and still running is neither done nor failed; showing it as
    // either is a false statement about the world.
    const sections = sectionsFor(
      summary({ in_flight: [entry({ id: "running", status: "undoing", in_flight: true })] }),
    );
    expect(sections.map((s) => s.key)).toEqual(["in_flight", "stack"]);
    expect(sections.find((s) => s.key === "stack")!.entries).toEqual([]);
  });

  it("hides the empty attention and progress sections", () => {
    expect(sectionsFor(summary({ stack: [entry()] })).map((s) => s.key)).toEqual(["stack"]);
  });

  it("offers an undo button only on the ordinary stack", () => {
    // A repair entry has already been attempted, and an in-flight one is
    // running; an Undo button on either would be a lie about what it does.
    const sections = sectionsFor(
      summary({
        stack: [entry()],
        repairs: [entry({ id: "bad", needs_repair: true })],
        in_flight: [entry({ id: "run", in_flight: true })],
      }),
    );
    expect(sections.filter((s) => s.actionable).map((s) => s.key)).toEqual(["stack"]);
  });

  it("survives a null summary rather than throwing on first paint", () => {
    expect(sectionsFor(null).map((s) => s.key)).toEqual(["stack"]);
  });

  it("marks only the attention section as dangerous", () => {
    const sections = sectionsFor(
      summary({ repairs: [entry({ needs_repair: true })], stack: [entry()] }),
    );
    expect(sections.filter((s) => s.tone === "danger").map((s) => s.key)).toEqual(["repairs"]);
  });
});

describe("describeEntry", () => {
  it("names the action and who took it", () => {
    expect(describeEntry(entry())).toBe("vault.write · agent");
  });

  it("warns when undoing means deleting", () => {
    // "Undo" on a create is a delete, and that is not obvious from the word.
    expect(describeEntry(entry({ creates_note: true }))).toContain("undoing deletes it");
  });

  it("carries the recorded outcome when there is one", () => {
    expect(describeEntry(entry({ outcome: "reversal failed: disk gone" }))).toContain(
      "reversal failed: disk gone",
    );
  });
});

/**
 * A refusal and a failure are different answers, and the difference is the
 * only part that tells the owner what to do next. Collapsing them into "it
 * didn't work" is the specific mistake these tests exist to prevent.
 */
describe("describeOutcome", () => {
  it("names what was undone on success", () => {
    const view = describeOutcome({ undone: true, entry: entry({ target: "invoice.md" }) });
    expect(view.tone).toBe("success");
    expect(view.headline).toContain("invoice.md");
    expect(view.offerForce).toBe(false);
  });

  it("offers 'undo anyway' after a refusal the owner can answer", () => {
    const view = describeOutcome({
      undone: false,
      refused: true,
      message: "note.md has changed since this was written.",
      conflict: { kind: "changed_since", message: "changed" },
      canForce: true,
    });
    expect(view.tone).toBe("warning");
    expect(view.offerForce).toBe(true);
    expect(view.detail).toContain("most likely something you typed");
  });

  it("offers no force when there is nothing left to restore", () => {
    // `backup_missing`: the button could only ever fail, so it would be a
    // promise the page cannot keep.
    const view = describeOutcome({
      undone: false,
      refused: true,
      message: "the saved previous version is no longer on disk",
      conflict: { kind: "backup_missing", message: "gone" },
      canForce: false,
    });
    expect(view.offerForce).toBe(false);
    expect(view.detail).toContain("nothing to restore");
  });

  it("never offers force after a failure", () => {
    // The reversal ran. Forcing would re-run an inverse that may have partly
    // applied, which is how a half-restored file becomes a fully wrong one.
    const view = describeOutcome({
      undone: false,
      failed: true,
      needsRepair: true,
      message: "the reversal did not take effect at the source",
      // Even if a server ever sent this, the answer stays no.
      canForce: true,
    });
    expect(view.tone).toBe("danger");
    expect(view.offerForce).toBe(false);
    expect(view.detail).toContain("needs a person");
  });

  it("does not present 'nothing to undo' as a failure", () => {
    const view = describeOutcome({ undone: false, reason: "nothing to undo" });
    expect(view.tone).toBe("warning");
    expect(view.headline).toBe("nothing to undo");
    expect(view.offerForce).toBe(false);
  });

  it("says something for a conflict kind it has never seen", () => {
    // A new conflict kind must not produce an empty banner with a button.
    const view = describeOutcome({
      undone: false,
      refused: true,
      message: "refused for a new reason",
      conflict: { kind: "something_new", message: "?" },
      canForce: true,
    });
    expect(view.headline).toBe("refused for a new reason");
    expect(view.detail).toBe("");
  });

  it("falls back to a plain sentence when the server said nothing", () => {
    expect(describeOutcome({} as UndoApplyResult).headline).toBe("Nothing happened.");
  });
});
