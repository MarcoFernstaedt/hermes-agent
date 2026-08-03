import { describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";

import type { ChatDraft } from "@/plugins/chat-drafts";
import {
  composeChatDraftMessage,
  insertChatDraftIntoNativeInput,
  prepareChatDraftForTerminalPaste,
  type NativeChatInput,
} from "./chat-draft-submit";
import { enqueuePtyOnData, knownPtyInput } from "./pty-mobile-input";

const draft: ChatDraft = {
  id: "draft-1",
  nonce: "0123456789abcdef0123456789abcdef",
  kind: "selection",
  title: "Reviewed page",
  sourceUrl: "https://example.com/article?view=wide",
  sourceUrlRedacted: true,
  queryDataPresent: true,
  context: "Bounded context",
  handoffOrigin: "https://dashboard.example.test",
  createdAt: 1_000,
  expiresAt: 61_000,
  acknowledged: true,
  state: "acknowledged",
};

function input(overrides: Partial<NativeChatInput> = {}): NativeChatInput {
  return {
    isConnected: () => true,
    isBusy: () => false,
    currentState: () => "empty",
    insert: vi.fn(() => "queued-unknown" as const),
    ...overrides,
  };
}

describe("native chat draft insertion", () => {
  it("composes editable multiline review as a single-line delimited JSON record", () => {
    const message = composeChatDraftMessage(draft, {
      title: "Reviewed title",
      context: "line one\nline two",
      request: "compare\nclaims",
    });

    expect(message).toMatch(/^IMPERATOR_REVIEWED_CONTEXT_V1=/);
    expect(message).not.toMatch(/[\r\n]/);
    const record = JSON.parse(message.slice("IMPERATOR_REVIEWED_CONTEXT_V1=".length));
    expect(record).toMatchObject({
      title: "Reviewed title",
      untrustedWebsiteMaterial: "line one\nline two",
      userRequest: "compare\nclaims",
    });
    expect(Array.from(message).some((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point < 32 || (point >= 127 && point <= 159);
    })).toBe(false);
  });

  it("preserves exact production terminal.paste/onData bytes without CR, LF, or submit intent", async () => {
    const message = composeChatDraftMessage(draft, {
      title: "Reviewed title",
      context: "line one\nline two",
      request: "compare claims",
    });

    for (const bracketedPasteMode of [false, true]) {
      const terminal = new Terminal();
      (terminal as unknown as { _core: { textarea: { value: string } } })._core.textarea = { value: "" };
      if (bracketedPasteMode) {
        await new Promise<void>((resolve) => terminal.write("\u001b[?2004h", resolve));
      }
      const sent: string[] = [];
      const submitIntent: boolean[] = [];
      terminal.onData((xtermOnData) => {
        const result = enqueuePtyOnData({
          data: xtermOnData,
          current: knownPtyInput(""),
          replacementActive: false,
          socketOpen: true,
          blocked: false,
          send: (data) => sent.push(data),
        });
        submitIntent.push(result.submitIntent);
      });

      terminal.paste(prepareChatDraftForTerminalPaste(message));

      const exactOutput = bracketedPasteMode
        ? `\u001b[200~${message}\u001b[201~`
        : message;
      expect(sent).toEqual([exactOutput]);
      expect(sent[0]).not.toMatch(/[\r\n]/);
      expect(submitIntent).toEqual([false]);
      terminal.dispose();
    }
  });

  it("fails closed instead of stripping a control byte", () => {
    expect(() => composeChatDraftMessage(draft, {
      title: "unsafe\u001btitle",
      context: "facts",
      request: "compare claims",
    })).toThrow(/control/i);
  });

  it("enforces request and composed-message limits in UTF-8 bytes", () => {
    expect(() => composeChatDraftMessage(draft, {
      title: "Reviewed",
      context: "facts",
      request: "😀".repeat(1_001),
    })).toThrow(/request/i);
  });

  it("inserts through the native input path without submitting", () => {
    const native = input();

    const result = insertChatDraftIntoNativeInput(native, draft, {
      title: draft.title,
      context: draft.context,
      request: "summarize",
    }, 2_000);

    expect(result).toEqual({
      disposition: "unknown",
      draftId: draft.id,
      message: "Draft bytes were queued without Enter; PTY acceptance is unknown. Inspect native Chat and do not retry automatically.",
    });
    expect(native.insert).toHaveBeenCalledOnce();
    expect(native.insert).toHaveBeenCalledWith(expect.not.stringContaining("\r"));
  });

  it.each([
    ["disconnected", input({ isConnected: () => false }), /connect/i],
    ["busy", input({ isBusy: () => true }), /busy/i],
    ["existing input", input({ currentState: () => "non-empty" }), /already contains/i],
    ["unknown input", input({ currentState: () => "unknown" }), /cannot be verified/i],
  ])("refuses %s native input", (_label, native, message) => {
    expect(() => insertChatDraftIntoNativeInput(native, draft, {
      title: draft.title,
      context: draft.context,
      request: "summarize",
    }, 2_000)).toThrow(message);
    expect(native.insert).not.toHaveBeenCalled();
  });

  it("refuses stale or previously inserted drafts", () => {
    const native = input();
    expect(() => insertChatDraftIntoNativeInput(native, draft, {
      title: draft.title,
      context: draft.context,
      request: "summarize",
    }, 61_000)).toThrow(/expired/i);
    expect(() => insertChatDraftIntoNativeInput(native, { ...draft, state: "inserted-unknown" }, {
      title: draft.title,
      context: draft.context,
      request: "summarize",
    }, 2_000)).toThrow(/already inserted/i);
  });

  it("retains unknown insertion status and never retries automatically", () => {
    const insert = vi.fn(() => "queued-unknown" as const);
    const native = input({ insert });

    const result = insertChatDraftIntoNativeInput(native, draft, {
      title: draft.title,
      context: draft.context,
      request: "summarize",
    }, 2_000);
    expect(result.disposition).toBe("unknown");
    expect(insert).toHaveBeenCalledOnce();
  });

  it("reports a failed enqueue once without retrying", () => {
    const insert = vi.fn(() => "failed" as const);
    const native = input({ insert });
    expect(() => insertChatDraftIntoNativeInput(native, draft, {
      title: draft.title,
      context: draft.context,
      request: "summarize",
    }, 2_000)).toThrow(/failed/i);
    expect(insert).toHaveBeenCalledOnce();
  });
});
