/**
 * The item lifecycle, mirrored for the client.
 *
 * The authority is `hermes_cli/items/lifecycle.py` — the server refuses illegal
 * transitions and the client must never assume otherwise. This mirror exists so
 * the card can *render* a state without a round trip, not so it can decide one.
 *
 * A test parses the Python enum and fails if the two drift, because a state the
 * client does not know about renders as a blank card, and a state the server
 * does not know about produces a rejected transition the owner cannot explain.
 */
export const State = {
  OPEN: "open",
  ACKNOWLEDGED: "acknowledged",
  AWAITING_DECISION: "awaiting_decision",
  MODIFYING: "modifying",
  SNOOZED: "snoozed",
  DENIED: "denied",
  EXPIRED: "expired",
  CANCELED: "canceled",
  APPROVED: "approved",
  QUEUED: "queued",
  EXECUTING: "executing",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  COMPENSATING: "compensating",
  COMPENSATED: "compensated",
  COMPENSATION_FAILED: "compensation_failed",
} as const;

export type ItemState = (typeof State)[keyof typeof State];

export const NOTIFICATION_CLASSES = [
  "blocking",
  "actionable",
  "opportunity",
  "informational",
] as const;

export type NotificationClass = (typeof NOTIFICATION_CLASSES)[number];

/** Sort rank — blocking first, matching CLASS_RANK server-side. */
export const CLASS_RANK: Record<NotificationClass, number> = {
  blocking: 0,
  actionable: 1,
  opportunity: 2,
  informational: 3,
};

export function classRank(klass: string): number {
  return CLASS_RANK[klass as NotificationClass] ?? 99;
}
