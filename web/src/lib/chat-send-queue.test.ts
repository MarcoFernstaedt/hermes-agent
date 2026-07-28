import { describe, expect, it } from "vitest";

import {
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
    const queue: QueuedSend[] = [{ id: "a", text: "first" }];
    expect(takeNextQueuedSend(queue, true)).toBeNull();
    expect(queue).toHaveLength(1);
  });

  it("releases exactly one message per idle transition, in order", () => {
    const queue: QueuedSend[] = [
      { id: "a", text: "first" },
      { id: "b", text: "second" },
    ];
    expect(takeNextQueuedSend(queue, false)).toEqual({ id: "a", text: "first" });
    expect(queue).toHaveLength(1);
    expect(takeNextQueuedSend(queue, false)).toEqual({ id: "b", text: "second" });
    expect(takeNextQueuedSend(queue, false)).toBeNull();
  });
});
