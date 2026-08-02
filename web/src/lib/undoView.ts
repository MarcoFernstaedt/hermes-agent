import type { UndoApplyResult, UndoEntry, UndoSummary } from "@/lib/api";

/**
 * What the undo screen decides, kept out of the component so it can be tested.
 *
 * Both decisions here are ones the screen gets wrong quietly if they live
 * inline: which sections appear and in what order, and what a given apply
 * result actually means. Neither is styling.
 */

export type SectionTone = "danger" | "muted";

export interface UndoSection {
  key: "repairs" | "in_flight" | "stack";
  title: string;
  description: string;
  tone: SectionTone;
  entries: UndoEntry[];
  /** Only the ordinary stack offers an undo button. */
  actionable: boolean;
}

/**
 * The sections to render, in the order they must appear.
 *
 * "Needs attention" is first and is never merged into the stack. Those entries
 * mean a reversal failed, or nobody knows whether it took effect — what the
 * owner was told and what is true may differ. Ranking them below a list of
 * successful undos is how they go unnoticed.
 *
 * "In progress" is separate because a claimed, still-running reversal is
 * neither done nor failed, and showing it as either is a false statement about
 * the world.
 *
 * The empty sections are dropped, except the stack: "Nothing to undo" is
 * information, whereas an empty attention list is just absence.
 */
export function sectionsFor(summary: UndoSummary | null): UndoSection[] {
  const repairs = summary?.repairs ?? [];
  const inFlight = summary?.in_flight ?? [];
  const stack = summary?.stack ?? [];

  const sections: UndoSection[] = [];
  if (repairs.length) {
    sections.push({
      key: "repairs",
      title: "Needs attention",
      description:
        "A reversal failed, or nobody knows whether it took effect. What you " +
        "were told and what is true may differ. These do not age out.",
      tone: "danger",
      entries: repairs,
      actionable: false,
    });
  }
  if (inFlight.length) {
    sections.push({
      key: "in_flight",
      title: "In progress",
      description: "Claimed and still running. Neither done nor failed.",
      tone: "muted",
      entries: inFlight,
      actionable: false,
    });
  }
  sections.push({
    key: "stack",
    title: "Can be undone",
    description: "Newest first.",
    tone: "muted",
    entries: stack,
    actionable: true,
  });
  return sections;
}

/** A one-line summary of an entry, for the row beneath its target. */
export function describeEntry(entry: UndoEntry): string {
  const parts = [entry.action, entry.actor];
  if (entry.creates_note) parts.push("undoing deletes it");
  if (entry.outcome) parts.push(entry.outcome);
  return parts.filter(Boolean).join(" · ");
}

export type OutcomeTone = "success" | "warning" | "danger";

export interface OutcomeView {
  tone: OutcomeTone;
  headline: string;
  /** Plain-language expansion, or "" when the headline says it all. */
  detail: string;
  /** Whether to offer "Undo anyway". Never true for a failure. */
  offerForce: boolean;
}

/**
 * What just happened, in terms the owner can act on.
 *
 * The distinction this exists to preserve: a **refusal** means nothing was
 * attempted and the entry is still offerable, so forcing is a real option. A
 * **failure** means the reversal ran and did not take, so the next step is
 * looking at it, not pressing the same button harder. Collapsing the two into
 * "it didn't work" loses the only part that tells the owner what to do.
 */
export function describeOutcome(result: UndoApplyResult): OutcomeView {
  if (result.undone) {
    const what = result.entry?.target || result.entry?.action || "the action";
    return { tone: "success", headline: `Undone: ${what}.`, detail: "", offerForce: false };
  }

  if (result.failed) {
    return {
      tone: "danger",
      headline: result.message ?? "The reversal did not take effect.",
      detail:
        "The reversal ran and did not take effect, so this needs a person " +
        "rather than another attempt. It is listed under “Needs attention”.",
      // Never: forcing re-runs an inverse that may have partly applied.
      offerForce: false,
    };
  }

  if (result.refused) {
    return {
      tone: "warning",
      headline: result.message ?? "Refused.",
      detail: conflictDetail(result.conflict?.kind),
      // `backup_missing` is the one conflict force cannot answer — there is
      // nothing to restore — so the server sets canForce false and the button
      // is not a promise the page can keep.
      offerForce: result.canForce === true,
    };
  }

  return {
    tone: "warning",
    headline: result.message ?? result.reason ?? "Nothing happened.",
    detail: "",
    offerForce: false,
  };
}

function conflictDetail(kind: string | undefined): string {
  switch (kind) {
    case "changed_since":
      return (
        "The file has changed since the agent wrote it. Undoing would " +
        "overwrite that change — most likely something you typed."
      );
    case "backup_missing":
      return (
        "The saved previous version is no longer on disk, so there is " +
        "nothing to restore."
      );
    case "backup_changed":
      return (
        "The saved previous version is not the one this undo was recorded " +
        "against."
      );
    case "unreadable":
      return "This entry could not be checked, so it was not attempted.";
    default:
      return "";
  }
}
