/**
 * The glance — three questions answered in half a second, from every route.
 *
 * "Is anything waiting on me? Is Imperator working? Is anything broken?" The
 * brief calls this the heartbeat of the app, and the hard part is not showing
 * the three values — it is announcing them to a screen reader *without* becoming
 * noise. Tool-loop chatter and token-level updates fire many times a second; a
 * live region wired straight to agent state would make the app unusable by
 * anyone listening to it.
 *
 * So this module is a pure derivation with one job beyond formatting: decide
 * which changes are worth saying out loud. Meaningful transitions announce
 * once. Everything else updates silently on screen, where glancing is free.
 */

/** What Imperator is doing. Ordered from calm to alarming. */
export type AgentActivity =
  | "offline"
  | "idle"
  | "thinking"
  | "streaming"
  | "tool"
  | "delegating"
  | "waiting"
  | "faulted";

export interface GlanceInput {
  /** Items in a state that still needs the owner. */
  blockingCount: number;
  activity: AgentActivity;
  /** Named tool, when `activity` is "tool". Shown, never announced on its own. */
  toolName?: string;
  /** Human-readable degradations: stale sources, unreachable devices, sick services. */
  problems: string[];
}

export interface Glance {
  blockingCount: number;
  activity: AgentActivity;
  toolName?: string;
  problems: string[];
  /** True when something needs a person — drives the accent treatment. */
  needsAttention: boolean;
  degraded: boolean;
  /** The full sentence a screen reader gets when something worth saying changes. */
  announcement: string;
  /** Compact visual label for the activity. */
  activityLabel: string;
}

const ACTIVITY_LABEL: Record<AgentActivity, string> = {
  offline: "Offline",
  idle: "Idle",
  thinking: "Thinking",
  streaming: "Replying",
  tool: "Working",
  delegating: "Delegating",
  waiting: "Waiting on you",
  faulted: "Faulted",
};

/**
 * Activities worth interrupting a listener for.
 *
 * `thinking`, `streaming` and `tool` are deliberately absent: they flip
 * constantly during a single turn, and announcing each one turns a normal reply
 * into a stream of interruptions. They are visible on screen throughout; what
 * gets *said* is the beginning and the end of the agent needing something.
 */
const ANNOUNCED_ACTIVITIES: ReadonlySet<AgentActivity> = new Set<AgentActivity>([
  "offline",
  "faulted",
  "waiting",
  "idle",
]);

export function deriveGlance(input: GlanceInput): Glance {
  const blockingCount = Math.max(0, Math.floor(input.blockingCount || 0));
  const problems = input.problems.filter((p) => p.trim().length > 0);
  const activity = input.activity;

  const parts: string[] = [];
  if (blockingCount > 0) {
    parts.push(`${blockingCount} item${blockingCount === 1 ? "" : "s"} waiting on you`);
  }
  parts.push(
    activity === "tool" && input.toolName
      ? `Imperator is running ${input.toolName}`
      : `Imperator is ${ACTIVITY_LABEL[activity].toLowerCase()}`,
  );
  if (problems.length > 0) {
    parts.push(
      problems.length === 1 ? problems[0] : `${problems.length} systems degraded`,
    );
  }

  return {
    blockingCount,
    activity,
    toolName: input.toolName,
    problems,
    needsAttention: blockingCount > 0 || activity === "waiting",
    degraded: problems.length > 0 || activity === "faulted" || activity === "offline",
    announcement: `${parts.join(". ")}.`,
    activityLabel:
      activity === "tool" && input.toolName ? input.toolName : ACTIVITY_LABEL[activity],
  };
}

/**
 * Should this change be announced?
 *
 * The rule: say something when the count of things waiting changes, when a
 * degradation appears or clears, or when the agent enters or leaves a state
 * that matters. Do not say anything for the ordinary churn of a turn in flight.
 *
 * `previous` of null is first render — silent, because announcing the current
 * state on page load would talk over whatever the user was doing to get here.
 */
export function shouldAnnounce(previous: Glance | null, next: Glance): boolean {
  if (previous === null) return false;
  if (previous.blockingCount !== next.blockingCount) return true;
  if (previous.problems.length !== next.problems.length) return true;
  if (previous.activity === next.activity) return false;
  // A transition is worth saying if either end of it is a state that matters.
  return (
    ANNOUNCED_ACTIVITIES.has(next.activity) || ANNOUNCED_ACTIVITIES.has(previous.activity)
  );
}

/** The tone the glance should carry. Exactly one, so the accent stays meaningful. */
export function glanceTone(g: Glance): "attention" | "degraded" | "working" | "calm" {
  if (g.needsAttention) return "attention";
  if (g.degraded) return "degraded";
  if (g.activity !== "idle" && g.activity !== "offline") return "working";
  return "calm";
}
