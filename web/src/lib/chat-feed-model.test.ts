import { describe, expect, it } from "vitest";

import {
  approvalChoiceKey,
  chatFeedReducer,
  createOptimisticUserMessage,
  getChatWelcome,
  hydrateSessionMessages,
  mergeHydratedFeedState,
  parseDashboardEventFrame,
  shouldApplyHydration,
  shouldHandleChannelEvent,
  shouldShowSlashCommands,
  type ChatFeedState,
} from "./chat-feed-model";

const empty: ChatFeedState = {
  messages: [],
  activeAssistantId: null,
  activeApprovalId: null,
  activeClarifyId: null,
};

describe("chat feed model", () => {
  it("adds a user message immediately in a truthful sending state", () => {
    const message = createOptimisticUserMessage("ship it", "client-1", 100);

    expect(message).toMatchObject({
      id: "client-1",
      role: "user",
      text: "ship it",
      status: "sending",
      timestamp: 100,
    });
  });

  it("acknowledges the optimistic user message and streams one assistant bubble", () => {
    let state: ChatFeedState = {
      ...empty,
      messages: [
        { ...createOptimisticUserMessage("hello", "client-1", 100), status: "waiting" },
      ],
    };

    state = chatFeedReducer(state, {
      type: "message.start",
      sessionId: "runtime-1",
      payload: {},
      now: 200,
    });
    state = chatFeedReducer(state, {
      type: "message.delta",
      sessionId: "runtime-1",
      payload: { text: "Hi" },
      now: 210,
    });
    state = chatFeedReducer(state, {
      type: "message.delta",
      sessionId: "runtime-1",
      payload: { text: " Marco" },
      now: 220,
    });

    expect(state.messages).toHaveLength(2);
    expect(state.messages[0]).toMatchObject({ role: "user", status: "sent" });
    expect(state.messages[1]).toMatchObject({
      role: "assistant",
      status: "streaming",
      text: "Hi Marco",
    });
  });

  it("completes the existing assistant stream without duplicating it", () => {
    let state = chatFeedReducer(empty, {
      type: "message.start",
      sessionId: "runtime-1",
      payload: {},
      now: 200,
    });
    state = chatFeedReducer(state, {
      type: "message.delta",
      sessionId: "runtime-1",
      payload: { text: "draft" },
      now: 210,
    });
    state = chatFeedReducer(state, {
      type: "message.complete",
      sessionId: "runtime-1",
      payload: { text: "final answer" },
      now: 220,
    });

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({
      role: "assistant",
      status: "sent",
      text: "final answer",
    });
    expect(state.activeAssistantId).toBeNull();
  });

  it("does not expose reasoning deltas in the visible assistant response", () => {
    const started = chatFeedReducer(empty, {
      type: "message.start",
      now: 100,
    });
    const reasoned = chatFeedReducer(started, {
      type: "reasoning.delta",
      payload: { text: "private chain of thought" },
      now: 101,
    });

    expect(
      reasoned.messages.some((message) =>
        message.text.includes("private chain of thought"),
      ),
    ).toBe(false);
  });

  it("upserts tool lifecycle output instead of losing or duplicating it", () => {
    let state = chatFeedReducer(empty, {
      type: "tool.start",
      sessionId: "runtime-1",
      payload: { tool_id: "tool-1", name: "terminal", args: { command: "date" } },
      now: 200,
    });
    state = chatFeedReducer(state, {
      type: "tool.complete",
      sessionId: "runtime-1",
      payload: { tool_id: "tool-1", name: "terminal", result: "Mon Jul 13", error: false },
      now: 220,
    });

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({
      id: "tool-tool-1",
      role: "tool",
      status: "sent",
      title: "terminal",
      text: "Mon Jul 13",
    });
  });

  it("surfaces approvals with all native choices and resolves the same card", () => {
    let state = chatFeedReducer(empty, {
      type: "approval.request",
      sessionId: "runtime-1",
      payload: {
        command: "rm example",
        description: "dangerous command",
        allow_permanent: true,
      },
      now: 200,
    });

    expect(state.messages[0]).toMatchObject({
      role: "approval",
      status: "waiting",
      text: "rm example",
      allowPermanent: true,
    });
    expect(approvalChoiceKey("once", true)).toBe("1");
    expect(approvalChoiceKey("session", true)).toBe("2");
    expect(approvalChoiceKey("always", true)).toBe("3");
    expect(approvalChoiceKey("deny", true)).toBe("4");
    expect(approvalChoiceKey("deny", false)).toBe("3");

    state = chatFeedReducer(state, {
      type: "approval.resolved",
      sessionId: "runtime-1",
      payload: { choice: "session" },
      now: 220,
    });
    expect(state.messages[0]).toMatchObject({ status: "sent", resolution: "session" });
    expect(state.activeApprovalId).toBeNull();
  });

  it("keeps stored user, assistant, system, and tool output during hydration", () => {
    const messages = hydrateSessionMessages([
      { role: "system", content: "policy" },
      { role: "user", content: "question", timestamp: 1 },
      { role: "assistant", content: "answer", timestamp: 2 },
      { role: "tool", content: "proof", tool_name: "terminal", timestamp: 3 },
    ]);

    expect(messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
    ]);
    expect(messages[3]).toMatchObject({ title: "terminal", text: "proof" });
  });

  it("reconciles only the ordered current-turn overlap and preserves an active stream", () => {
    const history = hydrateSessionMessages([
      { role: "user", content: "hello", timestamp: 1 },
      { role: "assistant", content: "Hello there", timestamp: 2 },
    ]);
    const merged = mergeHydratedFeedState(history, {
      ...empty,
      activeAssistantId: "live-assistant",
      messages: [
        {
          id: "live-user",
          role: "user",
          text: "hello",
          status: "sending",
          timestamp: 1.5,
        },
        {
          id: "live-assistant",
          role: "assistant",
          text: "Hello",
          status: "streaming",
          timestamp: 2.5,
        },
        {
          id: "live-tool",
          role: "tool",
          title: "check",
          text: "still running",
          status: "running",
          timestamp: 5,
        },
      ],
    });

    expect(merged.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(merged.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
    expect(merged.messages.some((message) => message.id === "live-assistant")).toBe(true);
    expect(merged.messages.some((message) => message.id === "live-tool")).toBe(true);
    expect(merged.activeAssistantId).toBe("live-assistant");
  });

  it("preserves a running tool row while reconciling hydrated overlap", () => {
    const history = hydrateSessionMessages([
      { role: "tool", content: "partial output", tool_name: "shell", timestamp: 2 },
    ]);
    const merged = mergeHydratedFeedState(history, {
      ...empty,
      messages: [
        {
          id: "tool-runtime-1",
          role: "tool",
          title: "shell",
          text: "partial output",
          status: "running",
          timestamp: 2.5,
        },
      ],
    });

    expect(merged.messages).toHaveLength(1);
    expect(merged.messages[0].id).toBe("tool-runtime-1");
    expect(merged.messages[0].status).toBe("running");

    const completed = chatFeedReducer(merged, {
      type: "tool.complete",
      payload: { tool_id: "runtime-1", name: "shell", result: "done" },
      now: 4,
    });
    expect(completed.messages).toHaveLength(1);
    expect(completed.messages[0]).toMatchObject({
      id: "tool-runtime-1",
      status: "sent",
      text: "done",
    });
  });

  it("preserves a legitimate repeated prompt outside the hydration overlap window", () => {
    const history = hydrateSessionMessages([
      { role: "user", content: "continue", timestamp: 1_700_000_000 },
    ]);
    const merged = mergeHydratedFeedState(history, {
      ...empty,
      messages: [
        {
          id: "new-turn",
          role: "user",
          text: "continue",
          status: "sending",
          timestamp: 1_700_000_002,
        },
      ],
    });

    expect(merged.messages.filter((message) => message.role === "user")).toHaveLength(2);
  });

  it("rejects events queued by an obsolete channel subscription", () => {
    expect(shouldHandleChannelEvent(3, 3, false)).toBe(true);
    expect(shouldHandleChannelEvent(2, 3, false)).toBe(false);
    expect(shouldHandleChannelEvent(3, 3, true)).toBe(false);
  });

  it("rejects hydration responses from an invalidated session generation", () => {
    expect(shouldApplyHydration(2, 2, "session-b", "session-b")).toBe(true);
    expect(shouldApplyHydration(1, 2, "session-a", "session-b")).toBe(false);
    expect(shouldApplyHydration(2, 2, "session-a", "session-b")).toBe(false);
  });

  it("parses the dashboard event relay envelope without dropping its session id", () => {
    expect(
      parseDashboardEventFrame(
        JSON.stringify({
          method: "event",
          params: {
            type: "message.delta",
            session_id: "runtime-1",
            payload: { text: "hello" },
          },
        }),
        99,
      ),
    ).toEqual({
      type: "message.delta",
      sessionId: "runtime-1",
      payload: { text: "hello" },
      now: 99,
    });
    expect(parseDashboardEventFrame("not json", 99)).toBeNull();
  });

  it("opens slash completion only for a slash command at the start of the composer", () => {
    expect(shouldShowSlashCommands("/")).toBe(true);
    expect(shouldShowSlashCommands("/mod")).toBe(true);
    expect(shouldShowSlashCommands("  /model")).toBe(false);
    expect(shouldShowSlashCommands("hello /model")).toBe(false);
  });

  it("greets a new chat by local time without hard-coding a user identity", () => {
    expect(getChatWelcome(new Date(2026, 6, 13, 8))).toEqual({
      greeting: "Good morning",
      prompt: "What should we get started on today?",
    });
    expect(getChatWelcome(new Date(2026, 6, 13, 14)).greeting).toBe(
      "Good afternoon",
    );
    expect(getChatWelcome(new Date(2026, 6, 13, 20)).greeting).toBe(
      "Good evening",
    );
  });
});
