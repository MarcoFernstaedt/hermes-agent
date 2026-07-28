import { describe, expect, it, vi } from "vitest";

import type { ChatFeedMessage } from "./chat-feed-model";
import { submitWriteApproval } from "./write-approval-flow";

const message: ChatFeedMessage = {
  id: "write-skill123",
  role: "write_approval",
  text: "Skill change staged",
  status: "waiting",
  timestamp: 1,
  pendingId: "skill123",
  subsystem: "skills",
  profile: "client",
};

describe("submitWriteApproval", () => {
  it("marks only the card submitting and resolves after a success acknowledgment", async () => {
    const dispatch = vi.fn();
    const resolve = vi.fn(async () => ({
      success: true,
      subsystem: "skills" as const,
      pending_id: "skill123",
      decision: "approve" as const,
    }));

    const accepted = await submitWriteApproval({
      choice: "approve",
      dispatch,
      inFlight: new Set(),
      message,
      profile: "client",
      resolve,
    });

    expect(accepted).toBe(true);
    expect(resolve).toHaveBeenCalledWith("skills", "skill123", "approve", "client");
    expect(dispatch.mock.calls.map(([event]) => event)).toEqual([
      {
        type: "write_approval.submitting",
        payload: { pending_id: "skill123", subsystem: "skills", profile: "client" },
      },
      {
        type: "write_approval.resolved",
        payload: {
          pending_id: "skill123",
          subsystem: "skills",
          profile: "client",
          decision: "approved",
        },
      },
    ]);
  });

  it("uses the scoped profile when a legacy card carries the current sentinel", async () => {
    const resolve = vi.fn(async () => ({
      success: true,
      subsystem: "skills" as const,
      pending_id: "skill123",
      decision: "approve" as const,
    }));

    await submitWriteApproval({
      choice: "approve",
      dispatch: vi.fn(),
      inFlight: new Set(),
      message: { ...message, profile: "current" },
      profile: "client",
      resolve,
    });

    expect(resolve).toHaveBeenCalledWith("skills", "skill123", "approve", "client");
  });

  it("returns the card to retryable waiting on rejection or network failure", async () => {
    for (const resolve of [
      vi.fn(async () => ({
        success: false,
        subsystem: "skills" as const,
        pending_id: "skill123",
        decision: "reject" as const,
        error: "in_progress",
      })),
      vi.fn(async () => {
        throw new Error("offline");
      }),
    ]) {
      const dispatch = vi.fn();

      const accepted = await submitWriteApproval({
        choice: "reject",
        dispatch,
        inFlight: new Set(),
        message,
        resolve,
      });

      expect(accepted).toBe(false);
      expect(dispatch.mock.calls.at(-1)?.[0]).toEqual({
        type: "write_approval.failed",
        payload: { pending_id: "skill123", subsystem: "skills", profile: "client" },
      });
    }
  });

  it("prevents duplicate or conflicting decisions while the card is submitting", async () => {
    let finish!: (value: {
      success: boolean;
      subsystem: "skills";
      pending_id: string;
      decision: "approve";
    }) => void;
    const resolve = vi.fn(
      () =>
        new Promise<{
          success: boolean;
          subsystem: "skills";
          pending_id: string;
          decision: "approve";
        }>((resolvePromise) => {
          finish = resolvePromise;
        }),
    );
    const dispatch = vi.fn();
    const inFlight = new Set<string>();

    const first = submitWriteApproval({
      choice: "approve",
      dispatch,
      inFlight,
      message,
      resolve,
    });
    const duplicate = await submitWriteApproval({
      choice: "reject",
      dispatch,
      inFlight,
      message,
      resolve,
    });
    finish({
      success: true,
      subsystem: "skills",
      pending_id: "skill123",
      decision: "approve",
    });

    expect(duplicate).toBe(false);
    expect(resolve).toHaveBeenCalledTimes(1);
    await expect(first).resolves.toBe(true);
  });

  it("treats a two-tab decision conflict as terminal", async () => {
    const dispatch = vi.fn();
    const accepted = await submitWriteApproval({
      choice: "reject",
      dispatch,
      inFlight: new Set(),
      message,
      resolve: vi.fn(async () => ({
        success: false,
        subsystem: "skills" as const,
        pending_id: "skill123",
        decision: "reject" as const,
        error: "decision_conflict",
      })),
    });

    expect(accepted).toBe(false);
    expect(dispatch.mock.calls.at(-1)?.[0]).toEqual({
      type: "write_approval.resolved",
      payload: {
        pending_id: "skill123",
        subsystem: "skills",
        profile: "client",
        decision: "already resolved",
      },
    });
  });

  it("rejects a mismatched success response and keeps the card retryable", async () => {
    const dispatch = vi.fn();
    const accepted = await submitWriteApproval({
      choice: "approve",
      dispatch,
      inFlight: new Set(),
      message,
      resolve: vi.fn(async () => ({
        success: true,
        subsystem: "memory" as const,
        pending_id: "skill123",
        decision: "approve" as const,
      })),
    });

    expect(accepted).toBe(false);
    expect(dispatch.mock.calls.at(-1)?.[0]).toEqual({
      type: "write_approval.failed",
      payload: { pending_id: "skill123", subsystem: "skills", profile: "client" },
    });
  });
});
