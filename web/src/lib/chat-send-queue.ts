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
  /**
   * Which conversation this belongs to.
   *
   * A message held for a socket that was reconnecting outlives everything else
   * "new chat" resets: the feed is cleared, the session is rotated, the durable
   * id is dropped — and then the reconnect flush fires on the next `ready` and
   * delivers the owner's words from the old chat into the new one, minutes
   * later, under a heading that says the chat is new.
   *
   * Tagging is how a flush can tell. The alternative — clearing the buffer from
   * the new-chat handler — was tried and is worse in two ways: it only covers
   * the one button, and the handler is declared above the buffer it would have
   * to reach.
   */
  session: number;
}

/**
 * Split held sends into the ones that still belong here and the ones that do
 * not.
 *
 * Stale sends are *dropped*, not failed: their bubbles went with the feed when
 * the conversation was replaced, so there is nothing left to mark, and marking
 * a message the owner can no longer see would be a notification about nothing.
 */
export function partitionBySession(
  queue: QueuedSend[],
  session: number,
): { flush: QueuedSend[]; stale: QueuedSend[] } {
  const flush: QueuedSend[] = [];
  const stale: QueuedSend[] = [];
  for (const item of queue) (item.session === session ? flush : stale).push(item);
  return { flush, stale };
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

/**
 * Pop the next queued send when the agent is idle; null when nothing to do.
 *
 * ``session`` discards anything composed in a conversation that has since been
 * replaced, for the same reason `partitionBySession` exists.
 */
export function takeNextQueuedSend(
  queue: QueuedSend[],
  agentRunning: boolean,
  session: number,
): QueuedSend | null {
  if (agentRunning) return null;
  let next = queue.shift();
  while (next && next.session !== session) next = queue.shift();
  return next ?? null;
}
