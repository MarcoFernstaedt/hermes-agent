/**
 * The order Now is read in — as data, so it can be asserted.
 *
 * For a screen-reader user the reading order *is* the design. Leaving it
 * implied by JSX nesting means any later refactor that moves a `<section>` for
 * layout reasons silently changes what Marco hears first, and no test notices.
 * So the order lives here, the page renders from it, and a test asserts it.
 *
 * Two rules that matter more than the order itself:
 *
 * **An absent thing is absent, not empty.** A section with nothing to say is
 * not rendered at all. An empty card still costs a screen-reader user a
 * heading, a landmark and a swipe to discover it says nothing — repeated every
 * morning. `visibleSections()` drops them.
 *
 * **Nothing is invented.** There is no placeholder, sample integration, KPI
 * tile with a dash in it, or "connect this to see more" prompt. A missing
 * integration is reported by the capability contract in words, in its own
 * place, and only when action is required.
 */

/** Every section Now can show, in the order they are read. */
export const NOW_SECTION_ORDER = [
  /** Page h1 plus current system state in plain language. Always present. */
  "heading",
  /** Today's selected outcome, from native Progress state. */
  "outcome",
  /** Income gate and routine completion. */
  "gate",
  /** Next confirmed calendar commitment. */
  "commitment",
  /** An active application / reply / interview Marco supplied. */
  "application",
  /** A material system exception — only when action is required. */
  "exception",
  /** The prominent way in to a conversation. Always present. */
  "ask",
  /** Links to deeper modules. Always present. */
  "links",
] as const;

export type NowSectionId = (typeof NOW_SECTION_ORDER)[number];

/** Sections that are part of the page's structure, not its content. */
const ALWAYS_PRESENT: readonly NowSectionId[] = ["heading", "ask", "links"];

export interface NowSection {
  id: NowSectionId;
  /** The section's accessible heading. Every section has one. */
  heading: string;
  /** True when there is something real to say. */
  hasContent: boolean;
}

export interface NowContent {
  /** Today's chosen outcome, or null when none is set. */
  outcome?: string | null;
  /** Routine completion, from Progress. */
  routines?: { completed: number; total: number } | null;
  incomeGate?: { met: boolean; label: string } | null;
  /** Next confirmed calendar item. */
  commitment?: { title: string; startsAt: string; link?: string | null } | null;
  /** An application/reply/interview Marco entered. Never sourced by us. */
  application?: { title: string; state: string } | null;
  /**
   * A system problem the owner has to act on. Informational degradations do
   * not belong here — a status the owner cannot act on is noise placed above
   * the thing they came for.
   */
  exception?: { summary: string; actionRequired: boolean } | null;
}

const HEADINGS: Record<NowSectionId, string> = {
  heading: "Now",
  outcome: "Today's outcome",
  gate: "Routines and income",
  commitment: "Next commitment",
  application: "Applications",
  exception: "Needs attention",
  ask: "Ask Imperator",
  links: "Elsewhere",
};

function hasContent(id: NowSectionId, content: NowContent): boolean {
  switch (id) {
    case "outcome":
      return Boolean(content.outcome && content.outcome.trim());
    case "gate":
      return Boolean(content.routines || content.incomeGate);
    case "commitment":
      return Boolean(content.commitment);
    case "application":
      return Boolean(content.application);
    case "exception":
      // Only when something must be done. A degraded-but-coping system does
      // not get to sit above the day's outcome.
      return Boolean(content.exception?.actionRequired);
    default:
      return ALWAYS_PRESENT.includes(id);
  }
}

/** Every section with its content flag, in reading order. */
export function nowSections(content: NowContent): NowSection[] {
  return NOW_SECTION_ORDER.map((id) => ({
    id,
    heading: HEADINGS[id],
    hasContent: hasContent(id, content),
  }));
}

/** Only the sections that will actually render, in reading order. */
export function visibleSections(content: NowContent): NowSection[] {
  return nowSections(content).filter((s) => s.hasContent);
}

/**
 * The one-line system state for the heading region.
 *
 * Deliberately plain language and deliberately short: this is the first thing
 * read on every visit, so it says what is true and stops.
 */
export function systemStateSentence(args: {
  capabilitiesNeedingAttention: number;
  chatReachable: boolean;
}): string {
  if (!args.chatReachable) {
    return "Imperator is not reachable right now.";
  }
  if (args.capabilitiesNeedingAttention === 1) {
    return "Imperator is running. One connection needs attention.";
  }
  if (args.capabilitiesNeedingAttention > 1) {
    return `Imperator is running. ${args.capabilitiesNeedingAttention} connections need attention.`;
  }
  return "Imperator is running.";
}

/**
 * How the routine and income line reads.
 *
 * Returns null when there is nothing to report, so the caller renders nothing
 * rather than a zero.
 */
export function gateSentence(content: NowContent): string | null {
  const parts: string[] = [];
  if (content.routines) {
    const { completed, total } = content.routines;
    parts.push(
      completed >= total && total > 0
        ? `All ${total} routines done.`
        : `${completed} of ${total} routines done.`,
    );
  }
  if (content.incomeGate) {
    parts.push(
      content.incomeGate.met
        ? `${content.incomeGate.label} met.`
        : `${content.incomeGate.label} not met yet.`,
    );
  }
  return parts.length ? parts.join(" ") : null;
}
