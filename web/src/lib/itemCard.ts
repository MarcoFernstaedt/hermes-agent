/**
 * The approve / deny / modify card — its logic, separated from its pixels.
 *
 * This is the most-used component in the app, and the place where a mistake is
 * most expensive: it is where the owner authorises things that leave the
 * machine. Three rules shape everything here.
 *
 * **Approval is not execution.** The card must never show a settled tick for an
 * email that has not sent. `cardPhase` maps the item's state to what the owner
 * is allowed to believe, and "decided" and "done" are different phases.
 *
 * **Never claim knowledge we do not have.** The smart-approval protocol returns
 * a one-word verdict at `max_tokens=16` and keeps no rationale, so the card
 * shows the verdict and the gate trigger and stops. A synthesised explanation
 * would read as authoritative while being invented.
 *
 * **Grouping must not blur consequence.** Batch approval is a real convenience
 * and a real hazard: twelve archives are one decision, but an archive and a
 * send are never one decision no matter how similar they look.
 */
import { State } from "./itemState";

/** What the card is doing, which is not the same as what the item is. */
export type CardPhase =
  | "deciding" // waiting on the owner
  | "modifying" // owner is editing the staged artifact
  | "submitting" // decision sent, not yet acknowledged
  | "working" // approved and running: queued or executing
  | "done" // verified outcome
  | "attention" // failed, or a compensation that failed
  | "closed"; // denied, expired, canceled, compensated

const PHASE_BY_STATE: Record<string, CardPhase> = {
  [State.OPEN]: "deciding",
  [State.ACKNOWLEDGED]: "deciding",
  [State.AWAITING_DECISION]: "deciding",
  [State.SNOOZED]: "closed",
  [State.MODIFYING]: "modifying",
  [State.APPROVED]: "working",
  [State.QUEUED]: "working",
  [State.EXECUTING]: "working",
  [State.SUCCEEDED]: "done",
  [State.FAILED]: "attention",
  [State.COMPENSATING]: "working",
  [State.COMPENSATED]: "closed",
  [State.COMPENSATION_FAILED]: "attention",
  [State.DENIED]: "closed",
  [State.EXPIRED]: "closed",
  [State.CANCELED]: "closed",
};

export function cardPhase(state: string): CardPhase {
  return PHASE_BY_STATE[state] ?? "deciding";
}

/** Only a card in `deciding` may offer decision buttons. */
export function canDecide(state: string): boolean {
  return cardPhase(state) === "deciding" && state !== State.SNOOZED;
}

/**
 * The status line, phrased so it cannot be misread as an outcome.
 *
 * "Approved" alone is the sentence that caused the whole aggregate-lifecycle
 * correction — it reads as "done" when it means "about to start".
 */
export function statusSentence(item: {
  state: string;
  outcome?: string;
  reason?: string;
  attempt?: number;
}): string {
  switch (item.state) {
    case State.APPROVED:
      return "Approved — not started yet.";
    case State.QUEUED:
      return "Approved and queued.";
    case State.EXECUTING:
      return item.attempt && item.attempt > 1
        ? `Running (attempt ${item.attempt})…`
        : "Running…";
    case State.SUCCEEDED:
      return item.outcome ? `Done. ${item.outcome}` : "Done.";
    case State.FAILED:
      return item.outcome ? `Failed. ${item.outcome}` : "Failed.";
    case State.DENIED:
      return item.reason ? `Denied — ${item.reason}` : "Denied.";
    case State.SNOOZED:
      return "Snoozed.";
    case State.EXPIRED:
      return "Expired without a decision.";
    case State.CANCELED:
      return "Canceled.";
    case State.COMPENSATING:
      return "Undoing…";
    case State.COMPENSATED:
      return "Undone.";
    case State.COMPENSATION_FAILED:
      // The world is in a state we tried and failed to reverse. Say so.
      return "Could not be undone — this needs you.";
    default:
      return "Waiting on you.";
  }
}

/** How reversible the action is, in the words shown at approval time. */
export type Permanence = "inverse" | "compensation" | "irreversible" | "unknown";

export function permanenceSentence(p: Permanence): string {
  switch (p) {
    case "inverse":
      return "This can be undone.";
    case "compensation":
      // Deliberately not "can be undone" — a best-effort reversal against an
      // external system is a different promise, and conflating them is how a
      // card comes to lie about what approval costs.
      return "This can be reversed afterwards, but not guaranteed — the reversal is a second request that can itself fail.";
    case "irreversible":
      return "This cannot be undone.";
    default:
      return "Reversibility unknown — treat as permanent.";
  }
}

export function isIrreversible(p: Permanence): boolean {
  return p === "irreversible" || p === "unknown";
}

/**
 * The verified facts behind an automated verdict.
 *
 * Returns only fields that exist. A missing verdict yields nothing rather than
 * a placeholder, because "no verdict" and "verdict unavailable" invite the
 * reader to assume a review happened.
 */
export interface VerdictFacts {
  verdict?: string;
  trigger?: string;
  tier?: string;
  scope?: string;
  payloadHash?: string;
}

export function verdictFacts(raw: Record<string, unknown>): VerdictFacts {
  const out: VerdictFacts = {};
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  out.verdict = str(raw.verdict);
  out.trigger = str(raw.description) ?? str(raw.trigger);
  out.tier = str(raw.tier);
  out.scope = str(raw.scope);
  out.payloadHash = str(raw.payload_hash);
  return Object.fromEntries(
    Object.entries(out).filter(([, v]) => v !== undefined),
  ) as VerdictFacts;
}

export function hasVerdictFacts(f: VerdictFacts): boolean {
  return Object.keys(f).length > 0;
}

/* ── batch approval ──────────────────────────────────────────────────── */

export interface BatchableItem {
  id: string;
  actionId: string;
  source: string;
  consequence: string;
  permanence: Permanence;
  title: string;
}

export interface BatchGroup {
  key: string;
  actionId: string;
  consequence: string;
  permanence: Permanence;
  items: BatchableItem[];
}

/**
 * Group pending items into safely-approvable batches.
 *
 * The grouping key includes the consequence class *and* the permanence, not
 * just the action type. Two calls to the same action can differ in blast
 * radius — an archive inside the app versus one that hits a provider — and a
 * batch that mixes them lets one click authorise something the owner was not
 * looking at.
 *
 * Irreversible actions are never grouped at all. The convenience of approving
 * twelve at once is not worth one unread send.
 */
export function groupForBatch(items: BatchableItem[]): {
  groups: BatchGroup[];
  ungrouped: BatchableItem[];
} {
  const byKey = new Map<string, BatchGroup>();
  const ungrouped: BatchableItem[] = [];

  for (const item of items) {
    if (isIrreversible(item.permanence)) {
      ungrouped.push(item);
      continue;
    }
    const key = [item.actionId, item.source, item.consequence, item.permanence].join("|");
    const existing = byKey.get(key);
    if (existing) existing.items.push(item);
    else {
      byKey.set(key, {
        key,
        actionId: item.actionId,
        consequence: item.consequence,
        permanence: item.permanence,
        items: [item],
      });
    }
  }

  const groups: BatchGroup[] = [];
  for (const group of byKey.values()) {
    // A "batch" of one is just an item; presenting it as a group adds a step.
    if (group.items.length < 2) ungrouped.push(...group.items);
    else groups.push(group);
  }
  return { groups, ungrouped };
}

export function batchSummary(group: BatchGroup): string {
  const n = group.items.length;
  const verb = group.actionId.split(".").slice(-1)[0].replace(/_/g, " ");
  return `${n} to ${verb}`;
}

/* ── modify ──────────────────────────────────────────────────────────── */

export interface ArtifactVersion {
  version: number;
  text: string;
  payloadHash: string;
}

/**
 * Whether a decision may still be applied to the version the owner is looking
 * at. Editing produces a *new* version and hash, so approving must re-target;
 * otherwise the owner reads v2 and authorises v1.
 */
export function decisionTargetsCurrentVersion(
  viewing: ArtifactVersion,
  current: ArtifactVersion,
): boolean {
  return viewing.version === current.version && viewing.payloadHash === current.payloadHash;
}

/** A compact, human count of what changed — not a raw diff dump. */
export function describeChanges(before: string, after: string): string {
  if (before === after) return "No changes.";
  const b = before.split(/\n/);
  const a = after.split(/\n/);
  let changed = 0;
  const max = Math.max(b.length, a.length);
  for (let i = 0; i < max; i += 1) if (b[i] !== a[i]) changed += 1;
  return changed === 1 ? "1 change." : `${changed} changes.`;
}
