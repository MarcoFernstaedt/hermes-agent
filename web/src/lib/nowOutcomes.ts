/**
 * Turning the hub's real state into candidates the ranker can order.
 *
 * This is the projection layer, and it is deliberately the only place that
 * knows how a review item or a due capability field maps onto consequence and
 * recovery time. Two reasons it is separate from both the ranker and the page:
 *
 * *It is where the invented data would come from.* Everything here is derived
 * from something the hub actually reported. There is no default outcome, no
 * placeholder, and no "get started" row — an empty hub produces an empty list,
 * and the page says so.
 *
 * *It is where the source is attached.* Every candidate carries where it came
 * from, so "says who" is answerable for every line on the page without the
 * page owning a second copy of the record.
 *
 * No store. Called on each read of a payload that already exists.
 */
import type { HubContext } from "@/lib/api";
import type { Consequence, OutcomeCandidate, Recovery } from "@/lib/outcomeRanking";

/**
 * How a pending decision's risk maps onto consequence.
 *
 * A decision the owner has not made is not the same as work not done: nothing
 * proceeds until they answer, so even a low-risk one blocks. `high` risk is
 * `severe` because these are the irreversible ones.
 */
const RISK_TO_CONSEQUENCE: Record<string, Consequence> = {
  high: "severe",
  medium: "high",
  low: "moderate",
};

function reviewConsequence(risk: string): Consequence {
  return RISK_TO_CONSEQUENCE[(risk || "").toLowerCase()] ?? "moderate";
}

/** Days until an ISO date, or null when it does not parse. */
function daysUntil(date: string, now: Date): number | null {
  const t = new Date(date).getTime();
  return Number.isNaN(t) ? null : (t - now.getTime()) / 86_400_000;
}

export function projectOutcomes(
  data: HubContext | null,
  now: Date = new Date(),
): OutcomeCandidate[] {
  if (!data) return [];
  const out: OutcomeCandidate[] = [];
  const { guardrails, review, jobs, capabilities, health } = data.sections;

  // A halted agent first, always: nothing else on this page can proceed while
  // it holds, so ranking it against ordinary work would bury the one item that
  // makes the others impossible.
  if (guardrails?.available && guardrails.halted) {
    out.push({
      id: "guardrail:halted",
      title: guardrails.note || "Imperator is halted",
      source: "incident",
      consequence: "severe",
      recovery: "irrecoverable",
      committed: true,
      safeToStart: false,
    });
  }

  // Decisions only the owner can make. Nothing proceeds until they answer.
  for (const item of review?.pending ?? []) {
    out.push({
      id: `review:${item.id}`,
      title: item.title,
      source: "incident",
      consequence: reviewConsequence(item.risk),
      recovery: "days",
      committed: true,
      // Awaiting a person by definition.
      safeToStart: false,
    });
  }

  // Applications and replies Marco entered. Never sourced by us — this reads
  // the tracker, it does not go looking for opportunities.
  for (const job of jobs?.next_actions ?? []) {
    out.push({
      id: `job:${job.id}`,
      title: `${job.role} — ${job.company}`,
      source: "jobs",
      consequence: "high",
      recovery: "days",
      income: true,
      // Preparing a packet is internal and reversible; sending it is not, and
      // sending is not what this represents.
      safeToStart: true,
    });
  }

  // Dated commitments the capability boards are carrying.
  for (const due of capabilities?.due_or_overdue ?? []) {
    const days = daysUntil(due.date, now);
    out.push({
      id: `capability:${due.capability}:${due.title}:${due.field}`,
      title: `${due.title} (${due.field})`,
      source: "calendar",
      // Overdue dated obligations are where real-world consequence lives —
      // a lapsed renewal is not recoverable by trying harder tomorrow.
      consequence: days !== null && days < 0 ? "severe" : "high",
      recovery: (days !== null && days < 0 ? "irrecoverable" : "days") as Recovery,
      dueAt: due.date,
      committed: true,
      safeToStart: false,
    });
  }

  // The app's own health, and only when it is actually broken. A degraded
  // system the owner cannot act on does not belong above their day.
  if (health?.available && health.status === "error" && health.problems.length) {
    out.push({
      id: "health:problems",
      title: health.problems[0],
      source: "incident",
      consequence: "high",
      recovery: "hours",
      safeToStart: false,
    });
  }

  return out;
}

/** Where the "why did this rank first" line points, per source. */
export const SOURCE_LINK: Record<string, string> = {
  jobs: "/jobs",
  incident: "/review",
  calendar: "/capabilities",
  progress: "/progress",
};
