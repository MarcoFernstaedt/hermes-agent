import { describe, expect, it } from "vitest";

import {
  partitionBySession,
  shouldQueueSend,
  takeNextQueuedSend,
  type QueuedSend,
} from "./chat-send-queue";

describe("shouldQueueSend", () => {
  it("queues a plain message while the agent is running", () => {
    expect(
      shouldQueueSend({
        agentRunning: true,
        isSlashCommand: false,
        answeringClarify: false,
      }),
    ).toBe(true);
  });

  it("never queues slash commands — /whistle must reach the PTY mid-run", () => {
    expect(
      shouldQueueSend({
        agentRunning: true,
        isSlashCommand: true,
        answeringClarify: false,
      }),
    ).toBe(false);
  });

  it("never queues clarify answers — the agent is blocked on them", () => {
    expect(
      shouldQueueSend({
        agentRunning: true,
        isSlashCommand: false,
        answeringClarify: true,
      }),
    ).toBe(false);
  });

  it("sends immediately when idle", () => {
    expect(
      shouldQueueSend({
        agentRunning: false,
        isSlashCommand: false,
        answeringClarify: false,
      }),
    ).toBe(false);
  });
});

describe("takeNextQueuedSend", () => {
  it("holds everything while the agent is running", () => {
    const queue: QueuedSend[] = [{ id: "a", text: "first", session: 0 }];
    expect(takeNextQueuedSend(queue, true, 0)).toBeNull();
    expect(queue).toHaveLength(1);
  });

  it("releases exactly one message per idle transition, in order", () => {
    const queue: QueuedSend[] = [
      { id: "a", text: "first", session: 0 },
      { id: "b", text: "second", session: 0 },
    ];
    expect(takeNextQueuedSend(queue, false, 0)).toEqual({
      id: "a", text: "first", session: 0,
    });
    expect(queue).toHaveLength(1);
    expect(takeNextQueuedSend(queue, false, 0)).toEqual({
      id: "b", text: "second", session: 0,
    });
    expect(takeNextQueuedSend(queue, false, 0)).toBeNull();
  });

  it("skips past messages from a conversation that was replaced", () => {
    const queue: QueuedSend[] = [
      { id: "old", text: "from the last chat", session: 0 },
      { id: "new", text: "from this one", session: 1 },
    ];
    expect(takeNextQueuedSend(queue, false, 1)?.id).toBe("new");
  });

  it("returns nothing when every held message is stale", () => {
    const queue: QueuedSend[] = [
      { id: "old-1", text: "a", session: 0 },
      { id: "old-2", text: "b", session: 0 },
    ];
    expect(takeNextQueuedSend(queue, false, 1)).toBeNull();
    expect(queue).toHaveLength(0);
  });
});

describe("partitionBySession", () => {
  /**
   * The leak this closes: a message held for a reconnecting socket outlives
   * everything "new chat" resets — the feed, the session, the durable id — and
   * then the flush fires on the next `ready` and delivers the owner's words
   * from the old chat into the new one, minutes later, under a heading that
   * says the chat is new.
   */
  it("keeps this conversation's held sends and sets the others aside", () => {
    const held: QueuedSend[] = [
      { id: "old", text: "before the new chat", session: 0 },
      { id: "new", text: "after it", session: 1 },
    ];
    const { flush, stale } = partitionBySession(held, 1);
    expect(flush.map((m) => m.id)).toEqual(["new"]);
    expect(stale.map((m) => m.id)).toEqual(["old"]);
  });

  it("keeps everything when nothing has changed", () => {
    const held: QueuedSend[] = [
      { id: "a", text: "one", session: 3 },
      { id: "b", text: "two", session: 3 },
    ];
    expect(partitionBySession(held, 3).flush).toHaveLength(2);
    expect(partitionBySession(held, 3).stale).toEqual([]);
  });

  it("preserves order within each side", () => {
    const held: QueuedSend[] = [
      { id: "a", text: "1", session: 1 },
      { id: "b", text: "2", session: 0 },
      { id: "c", text: "3", session: 1 },
    ];
    const { flush, stale } = partitionBySession(held, 1);
    expect(flush.map((m) => m.id)).toEqual(["a", "c"]);
    expect(stale.map((m) => m.id)).toEqual(["b"]);
  });

  it("handles an empty buffer", () => {
    expect(partitionBySession([], 0)).toEqual({ flush: [], stale: [] });
  });
});
