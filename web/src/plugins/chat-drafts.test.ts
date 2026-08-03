import { describe, expect, it, vi } from "vitest";

import { createChatDraftRegistry } from "./chat-drafts";

const payload = {
  id: "draft-1",
  nonce: "0123456789abcdef0123456789abcdef",
  kind: "selection" as const,
  title: "Reviewed page",
  sourceUrl: "https://example.com/article",
  sourceUrlRedacted: false,
  queryDataPresent: false,
  context: "Bounded context",
  handoffOrigin: "https://dashboard.example.test",
  createdAt: 1_000,
  expiresAt: 61_000,
};

describe("chat draft registry", () => {
  it("opens an in-memory draft and notifies subscribers without sending it", () => {
    const registry = createChatDraftRegistry({
      expectedHandoffOrigin: "https://dashboard.example.test",
      now: () => 1_000,
    });
    const snapshots: string[][] = [];
    registry.subscribe((drafts) => snapshots.push(drafts.map((draft) => draft.id)));

    const opened = registry.openDraft(payload);

    expect(opened.id).toBe("draft-1");
    expect(registry.list()).toEqual([expect.objectContaining({ id: "draft-1", acknowledged: false })]);
    expect(snapshots).toEqual([[], ["draft-1"]]);
  });

  it("rejects a handoff that does not name the exact Dashboard origin", () => {
    const registry = createChatDraftRegistry({
      expectedHandoffOrigin: "https://dashboard.example.test",
      now: () => 1_000,
    });

    expect(() =>
      registry.openDraft({ ...payload, handoffOrigin: "https://lookalike.example.test" }),
    ).toThrow("handoff origin");
    expect(registry.list()).toEqual([]);
  });

  it.each([
    ["expired", { expiresAt: 999 }],
    ["future timestamp", { createdAt: 40_001, expiresAt: 50_000 }],
    ["overlong lifetime", { expiresAt: 700_001 }],
    ["invalid nonce", { nonce: "short" }],
    ["invalid id", { id: "spaces are forbidden" }],
    ["invalid kind", { kind: "dom" }],
    ["overlong title", { title: "t".repeat(301) }],
    ["overlong context", { context: "c".repeat(6_001) }],
    ["non-http source", { sourceUrl: "file:///private" }],
    ["Dashboard source", { sourceUrl: "https://dashboard.example.test/private" }],
  ])("rejects %s payloads before insertion", (_label, changes) => {
    const registry = createChatDraftRegistry({
      expectedHandoffOrigin: "https://dashboard.example.test",
      now: () => 1_000,
    });

    expect(() => registry.openDraft({ ...payload, ...changes } as typeof payload)).toThrow();
    expect(registry.list()).toEqual([]);
  });

  it("rejects replayed nonces even after the first draft is cleared", () => {
    const registry = createChatDraftRegistry({
      expectedHandoffOrigin: "https://dashboard.example.test",
      now: () => 1_000,
    });
    registry.openDraft(payload);
    expect(registry.clear(payload.id)).toBe(true);

    expect(() => registry.openDraft({ ...payload, id: "draft-2" })).toThrow("replay");
    expect(registry.list()).toEqual([]);
  });

  it("expires an open draft in memory and notifies subscribers", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const registry = createChatDraftRegistry({
        expectedHandoffOrigin: "https://dashboard.example.test",
      });
      const sizes: number[] = [];
      registry.subscribe((drafts: readonly { id: string }[]) => sizes.push(drafts.length));
      registry.openDraft({ ...payload, expiresAt: 2_000 });

      vi.advanceTimersByTime(1_000);

      expect(registry.list()).toEqual([]);
      expect(sizes).toEqual([0, 1, 0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("delivers the current volatile draft to a late subscriber", () => {
    const registry = createChatDraftRegistry({
      expectedHandoffOrigin: "https://dashboard.example.test",
      now: () => 1_000,
    });
    registry.openDraft(payload);
    const snapshots: string[][] = [];

    registry.subscribe((drafts) => snapshots.push(drafts.map((draft) => draft.id)));

    expect(snapshots).toEqual([["draft-1"]]);
  });

  it("treats the same id nonce and payload as one idempotent draft", () => {
    const registry = createChatDraftRegistry({
      expectedHandoffOrigin: "https://dashboard.example.test",
      now: () => 1_000,
    });
    const first = registry.openDraft(payload);
    const duplicate = registry.openDraft(payload);

    expect(duplicate).toEqual(first);
    expect(registry.list()).toHaveLength(1);
  });

  it("enforces UTF-8 byte bounds instead of JavaScript code-unit counts", () => {
    const registry = createChatDraftRegistry({
      expectedHandoffOrigin: "https://dashboard.example.test",
      now: () => 1_000,
    });

    expect(() => registry.openDraft({ ...payload, title: "😀".repeat(76) })).toThrow(/title/i);
    expect(() => registry.openDraft({ ...payload, context: "界".repeat(2_001) })).toThrow(/context/i);
  });

  it("rejects C0 C1 and escape controls while allowing normalized line feeds", () => {
    const registry = createChatDraftRegistry({
      expectedHandoffOrigin: "https://dashboard.example.test",
      now: () => 1_000,
    });

    expect(() => registry.openDraft({ ...payload, context: "safe\nline" })).not.toThrow();
    expect(() => registry.openDraft({ ...payload, id: "draft-2", nonce: "2".repeat(32), context: "bad\u001bvalue" })).toThrow(/control/i);
    expect(() => registry.openDraft({ ...payload, id: "draft-3", nonce: "3".repeat(32), context: "bad\u0085value" })).toThrow(/control/i);
  });

  it("keeps drafts process-local and does not reconstruct them after a registry reload", () => {
    const firstProcess = createChatDraftRegistry({
      expectedHandoffOrigin: "https://dashboard.example.test",
      now: () => 1_000,
    });
    firstProcess.openDraft(payload);
    firstProcess.acknowledge(payload.id);

    const reloadedProcess = createChatDraftRegistry({
      expectedHandoffOrigin: "https://dashboard.example.test",
      now: () => 1_000,
    });

    expect(firstProcess.list()).toHaveLength(1);
    expect(reloadedProcess.list()).toEqual([]);
  });

  it("marks native insertion once and retains the draft until explicit dismissal", () => {
    const registry = createChatDraftRegistry({
      expectedHandoffOrigin: "https://dashboard.example.test",
      now: () => 1_000,
    });
    registry.openDraft(payload);
    expect(registry.acknowledge(payload.id)).toBe(true);
    expect(registry.markInserted(payload.id)).toBe(true);
    expect(registry.markInserted(payload.id)).toBe(false);
    expect(registry.list()[0]?.state).toBe("inserted-unknown");
    expect(registry.list()).toHaveLength(1);
  });

  it("bounds the in-memory queue and rejects a conflicting duplicate draft id", () => {
    const registry = createChatDraftRegistry({
      expectedHandoffOrigin: "https://dashboard.example.test",
      now: () => 1_000,
    });
    for (let index = 0; index < 5; index += 1) {
      registry.openDraft({
        ...payload,
        id: `draft-${index}`,
        nonce: `${index}`.repeat(32),
      });
    }
    expect(() =>
      registry.openDraft({ ...payload, id: "draft-5", nonce: "a".repeat(32) }),
    ).toThrow("capacity");

    registry.clear("draft-0");
    expect(() =>
      registry.openDraft({ ...payload, id: "draft-1", nonce: "b".repeat(32) }),
    ).toThrow("id");
  });

  it("expires synchronously on list, read, acknowledge, insertion, and submission observation", () => {
    let current = 1_000;
    const registry = createChatDraftRegistry({
      expectedHandoffOrigin: "https://dashboard.example.test",
      now: () => current,
    });
    registry.openDraft({ ...payload, id: "expiring", nonce: "e".repeat(32), expiresAt: 1_001 });
    current = 1_001;

    expect(registry.list()).toEqual([]);
    expect(registry.get("expiring")).toBeNull();
    expect(registry.acknowledge("expiring")).toBe(false);
    expect(registry.markInserted("expiring")).toBe(false);
    expect(registry.markSubmissionUnknown("expiring")).toBe(false);
    expect(registry.markSubmissionFailed("expiring")).toBe(false);
  });

  it("retains inserted and submitted-unknown observations without retry claims", () => {
    const registry = createChatDraftRegistry({
      expectedHandoffOrigin: "https://dashboard.example.test",
      now: () => 1_000,
    });
    registry.openDraft(payload);
    registry.acknowledge(payload.id);

    expect(registry.markInserted(payload.id)).toBe(true);
    expect(registry.get(payload.id)?.state).toBe("inserted-unknown");
    expect(registry.markInserted(payload.id)).toBe(false);
    expect(registry.markSubmissionUnknown(payload.id)).toBe(true);
    expect(registry.get(payload.id)?.state).toBe("submitted-unknown");
    expect(registry.markSubmissionUnknown(payload.id)).toBe(false);
    expect(registry.list()).toHaveLength(1);
  });

  it("records failed PTY enqueue without treating it as submitted", () => {
    const registry = createChatDraftRegistry({
      expectedHandoffOrigin: "https://dashboard.example.test",
      now: () => 1_000,
    });
    registry.openDraft(payload);
    registry.acknowledge(payload.id);
    registry.markInserted(payload.id);

    expect(registry.markSubmissionFailed(payload.id)).toBe(true);
    expect(registry.get(payload.id)?.state).toBe("failed");
    expect(registry.markSubmissionUnknown(payload.id)).toBe(false);
  });

  it("records a failed insertion enqueue before any inserted state", () => {
    const registry = createChatDraftRegistry({
      expectedHandoffOrigin: "https://dashboard.example.test",
      now: () => 1_000,
    });
    registry.openDraft(payload);
    registry.acknowledge(payload.id);

    expect(registry.markInsertionFailed(payload.id)).toBe(true);
    expect(registry.get(payload.id)?.state).toBe("failed");
    expect(registry.markInsertionFailed(payload.id)).toBe(false);
  });
});
