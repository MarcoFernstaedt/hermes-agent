/**
 * Which three things matter today, which one Imperator would do first, and why.
 *
 * Two failure modes shape this module, and they pull in opposite directions.
 *
 * The first is a recommendation the owner cannot interrogate. "Do this" with no
 * stated reason is either obeyed without thought or ignored entirely, and both
 * are worse than no recommendation. So `why` is not a nicety — a ranked outcome
 * without a reason it outranked the others is not shippable, and `rankOutcomes`
 * produces one for every item.
 *
 * The second is an income gate that eats the day. Runway matters, and a ranker
 * tuned only for it will happily put an invoice above a hospital appointment.
 * So consequence and recovery time dominate the score, leverage breaks ties,
 * and `income` is one factor among several rather than the axis.
 *
 * Nothing here is a store. Outcomes are *projected* from systems that already
 * own them — Progress owns the selected daily outcome, Calendar owns events,
 * Gmail owns mail — and each carries the `source` it came from so the owner can
 * always ask "says who". Ranking is a pure function over that projection,
 * recomputed on read. A second Today database is exactly what this avoids.
 */

/** Where a projected item actually lives. Never our own copy of it. */
export type OutcomeSource =
  | "progress"
  | "calendar"
  | "gmail"
  | "jobs"
  | "health"
  | "housing"
  | "finance"
  | "relationship"
  | "incident";

/**
 * How bad it is if this does not happen.
 *
 * `severe` is reserved for harm that cannot be undone by trying again later —
 * a missed medical appointment, an eviction notice, a lapsed policy. Ordinary
 * money pressure is `high`, not `severe`, or the scale collapses into one
 * value and stops ranking anything.
 */
export type Consequence = "severe" | "high" | "moderate" | "low";

/** How long it takes to recover if it slips. Shorter is less urgent. */
export type Recovery = "irrecoverable" | "weeks" | "days" | "hours";

export interface OutcomeCandidate {
  id: string;
  title: string;
  source: OutcomeSource;
  consequence: Consequence;
  recovery: Recovery;
  /** ISO date. Absent means no deadline, which is not the same as "not soon". */
  dueAt?: string | null;
  /** Does finishing this unblock other things? Ties break toward leverage. */
  leverage?: boolean;
  /** Already committed to someone else — a promise, not a plan. */
  committed?: boolean;
  /** Advances the income gate. One factor, never the axis. */
  income?: boolean;
  /** True when the work is internal and reversible, so it may start itself. */
  safeToStart?: boolean;
}

export interface RankedOutcome extends OutcomeCandidate {
  score: number;
  /** Why this ranked where it did, in short plain language. Never empty. */
  why: string;
  /** Exactly one item in a ranking carries this. */
  recommended: boolean;
}

const CONSEQUENCE_WEIGHT: Record<Consequence, number> = {
  severe: 100,
  high: 60,
  moderate: 30,
  low: 10,
};

const RECOVERY_WEIGHT: Record<Recovery, number> = {
  irrecoverable: 50,
  weeks: 30,
  days: 15,
  hours: 5,
};

const SOURCE_LABEL: Record<OutcomeSource, string> = {
  progress: "Progress",
  calendar: "Calendar",
  gmail: "Gmail",
  jobs: "Applications",
  health: "Health",
  housing: "Housing",
  finance: "Finance",
  relationship: "People",
  incident: "Incident",
};

/** Days until due; large when there is no deadline, negative when overdue. */
function daysUntil(dueAt: string | null | undefined, now: Date): number {
  if (!dueAt) return Number.POSITIVE_INFINITY;
  const due = new Date(dueAt).getTime();
  if (Number.isNaN(due)) return Number.POSITIVE_INFINITY;
  return (due - now.getTime()) / 86_400_000;
}

/**
 * Deadline pressure. Overdue outranks due-today, which outranks the rest.
 *
 * Deliberately flat past a week: something due in nine days and something due
 * in thirty are both "not today", and letting them separate would rank a
 * distant deadline above a same-day commitment with no deadline at all.
 */
function deadlineWeight(days: number): number {
  if (!Number.isFinite(days)) return 0;
  if (days < 0) return 45;
  if (days < 1) return 35;
  if (days < 3) return 20;
  if (days < 7) return 10;
  return 0;
}

export function scoreOutcome(item: OutcomeCandidate, now: Date = new Date()): number {
  return (
    CONSEQUENCE_WEIGHT[item.consequence] +
    RECOVERY_WEIGHT[item.recovery] +
    deadlineWeight(daysUntil(item.dueAt, now)) +
    (item.committed ? 20 : 0) +
    (item.leverage ? 12 : 0) +
    // Present, and small. Runway matters; a ranker tuned only for it puts an
    // invoice above a hospital appointment.
    (item.income ? 8 : 0)
  );
}

/**
 * The sentence shown under a ranked outcome.
 *
 * Built from the factors that actually moved the score, strongest first, so it
 * is an explanation rather than a description. If it ever disagrees with the
 * ranking, the ranking is what is wrong.
 */
export function explainOutcome(item: OutcomeCandidate, now: Date = new Date()): string {
  const reasons: string[] = [];
  const days = daysUntil(item.dueAt, now);

  if (item.consequence === "severe") reasons.push("the consequence is severe");
  else if (item.consequence === "high") reasons.push("the consequence is high");

  if (item.recovery === "irrecoverable") reasons.push("it cannot be recovered later");
  else if (item.recovery === "weeks") reasons.push("recovery would take weeks");

  if (Number.isFinite(days)) {
    if (days < 0) reasons.push("it is overdue");
    else if (days < 1) reasons.push("it is due today");
    else if (days < 3) reasons.push("it is due within days");
  }

  if (item.committed) reasons.push("you committed to it");
  if (item.leverage) reasons.push("it unblocks other work");
  if (item.income) reasons.push("it moves the income gate");

  const from = SOURCE_LABEL[item.source];
  if (!reasons.length) {
    // Never empty: an item with no distinguishing factor still has to say
    // where it came from, or the owner cannot check it.
    return `From ${from}. Nothing about it is urgent.`;
  }
  const list =
    reasons.length === 1
      ? reasons[0]
      : `${reasons.slice(0, -1).join(", ")} and ${reasons[reasons.length - 1]}`;
  return `From ${from}: ${list}.`;
}

export interface Ranking {
  /** At most three, best first. */
  top: RankedOutcome[];
  /** The id Imperator would start with, or null when there is nothing to do. */
  recommendedId: string | null;
  /** How many candidates existed, so the UI can say "3 of 11". */
  consideredCount: number;
}

/**
 * Rank candidates and mark one recommendation.
 *
 * `overrideId` is the owner's replacement. It wins outright and keeps its
 * explanation — the point of an override is that Marco's judgement beats the
 * score, so the UI must not quietly re-rank around it. An override naming an
 * item that no longer exists is ignored rather than obeyed into an empty
 * recommendation.
 */
export function rankOutcomes(
  candidates: OutcomeCandidate[],
  { now = new Date(), overrideId = null as string | null, limit = 3 } = {},
): Ranking {
  const scored = candidates
    .map((item) => ({
      ...item,
      score: scoreOutcome(item, now),
      why: explainOutcome(item, now),
      recommended: false,
    }))
    // Stable within equal scores: `id` breaks ties so two renders of the same
    // state never disagree about the order.
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  const override = overrideId ? scored.find((s) => s.id === overrideId) : undefined;
  // The override is promoted into the visible list even if it scored outside
  // it — a recommendation the owner cannot see is not a recommendation.
  const top = override
    ? [override, ...scored.filter((s) => s.id !== override.id)].slice(0, limit)
    : scored.slice(0, limit);

  const recommended = override ?? top[0] ?? null;
  return {
    top: top.map((item) => ({ ...item, recommended: item.id === recommended?.id })),
    recommendedId: recommended?.id ?? null,
    consideredCount: candidates.length,
  };
}

/**
 * Whether safe work on an outcome may start without asking.
 *
 * Only internal, reversible work qualifies. Anything that leaves the machine,
 * spends money, or cannot be undone crosses a protected boundary and waits —
 * `safeToStart` is a claim the *producer* makes, and this is the second gate
 * that decides whether to believe it.
 */
export type WorkState = "not_started" | "running" | "awaiting_you" | "blocked_by_approval";

export function workStateFor(
  item: OutcomeCandidate,
  { started = false, approvalPending = false } = {},
): WorkState {
  if (approvalPending) return "blocked_by_approval";
  if (started) return "running";
  if (!item.safeToStart) return "awaiting_you";
  return "not_started";
}

export const WORK_STATE_LABEL: Record<WorkState, string> = {
  not_started: "Not started",
  running: "Imperator is working on this",
  awaiting_you: "Waiting for you",
  blocked_by_approval: "Waiting for your approval",
};
