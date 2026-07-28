/**
 * Queue semantics for composer sends while the agent is mid-run.
 *
 * A plain message typed during an active run must NOT be written to the
 * PTY immediately — that steers the running turn. It is held locally
 * (bubble status "waiting") and flushed one-at-a-time as runs complete,
 * so each queued message starts its own turn in order.
 *
 * Two kinds of input bypass the queue on purpose:
 *  - slash commands (`/whistle`, `/model`, …) — control commands the TUI
 *    handles immediately, run or no run;
 *  - clarify answers — the agent is blocked waiting for exactly this input.
 */

export interface QueuedSend {
  id: string;
  text: string;
}

export function shouldQueueSend(options: {
  agentRunning: boolean;
  isSlashCommand: boolean;
  answeringClarify: boolean;
}): boolean {
  return (
    options.agentRunning &&
    !options.isSlashCommand &&
    !options.answeringClarify
  );
}

/** Pop the next queued send when the agent is idle; null when nothing to do. */
export function takeNextQueuedSend(
  queue: QueuedSend[],
  agentRunning: boolean,
): QueuedSend | null {
  if (agentRunning) return null;
  return queue.shift() ?? null;
}
