/**
 * The routing that the native acceptance run caught missing.
 *
 * Every test here asks the same question in a different place: when native
 * chat is on, does this action reach the native session — or does it still go
 * to a terminal that native mode deliberately never opened? A source-string
 * check ("does ChatPage mention nativeChat.submit") cannot answer that. These
 * call the real transport with both sides faked and watch which one is touched.
 */
import { describe, expect, it } from "vitest";

import {
  composerReady,
  createChatTransport,
  wireText,
  type NativeSide,
  type PtySide,
} from "./chatTransport";
import type { NativeChatStatus, SubmitOutcome } from "./nativeChat";

function fakes(
  over: {
    nativeActive?: boolean;
    nativeStatus?: NativeChatStatus;
    submitOutcome?: SubmitOutcome;
    submitThrows?: boolean;
    approvalThrows?: boolean;
    clarifyThrows?: boolean;
    ptyOpen?: boolean;
    ptyEnded?: boolean;
  } = {},
) {
  const nativeCalls: Array<[string, ...unknown[]]> = [];
  const ptyCalls: Array<[string, string]> = [];

  const native: NativeSide = {
    active: over.nativeActive ?? true,
    status: over.nativeStatus ?? "ready",
    async submit(text, clientToken) {
      nativeCalls.push(["submit", text, clientToken]);
      if (over.submitThrows) throw new Error("socket down");
      return over.submitOutcome ?? "accepted";
    },
    async interrupt() {
      nativeCalls.push(["interrupt"]);
    },
    async respondApproval(choice, opts) {
      nativeCalls.push(["respondApproval", choice, opts]);
      if (over.approvalThrows) throw new Error("no pending approval");
    },
    async respondClarify(requestId, answer) {
      nativeCalls.push(["respondClarify", requestId, answer]);
      if (over.clarifyThrows) throw new Error("no pending clarify");
    },
  };

  const open = over.ptyOpen ?? true;
  const pty: PtySide = {
    sendText(text) {
      ptyCalls.push(["sendText", text]);
      return open;
    },
    sendRaw(bytes) {
      ptyCalls.push(["sendRaw", bytes]);
      return open;
    },
    open,
    ended: over.ptyEnded ?? false,
  };

  const transport = createChatTransport({
    native: () => native,
    pty: () => pty,
  });
  return { transport, nativeCalls, ptyCalls, native, pty };
}

const plain = { agentRunning: false, isSlashCommand: false, answeringClarify: false };

describe("submission", () => {
  it("goes to the native session and never touches the terminal", async () => {
    const { transport, nativeCalls, ptyCalls } = fakes();
    expect(await transport.send("ship it", plain)).toBe("sent");
    expect(nativeCalls).toEqual([["submit", "ship it", undefined]]);
    expect(ptyCalls).toEqual([]);
  });

  it("still uses the terminal when native chat is off", async () => {
    const { transport, nativeCalls, ptyCalls } = fakes({ nativeActive: false });
    expect(await transport.send("ship it", plain)).toBe("sent");
    expect(ptyCalls).toEqual([["sendText", "ship it"]]);
    expect(nativeCalls).toEqual([]);
  });

  it("reports a queued send as queued, not as a failure", async () => {
    // The gateway queues a mid-turn submit. Rendering that as an error would
    // tell the owner their message was lost when it is about to run.
    const { transport } = fakes({ submitOutcome: "queued" });
    expect(await transport.send("and one more", { ...plain, agentRunning: true }))
      .toBe("queued");
  });

  it("treats a steered send as delivered", async () => {
    const { transport } = fakes({ submitOutcome: "steered" });
    expect(await transport.send("actually, stop", plain)).toBe("sent");
  });

  it("reports failure rather than pretending, when the submit throws", async () => {
    const { transport } = fakes({ submitThrows: true });
    expect(await transport.send("ship it", plain)).toBe("failed");
  });

  it("reports failure when the terminal socket is closed", async () => {
    const { transport } = fakes({ nativeActive: false, ptyOpen: false });
    expect(await transport.send("ship it", plain)).toBe("failed");
  });
});

describe("the /queue prefix belongs to the terminal only", () => {
  it("prefixes a mid-run message on the PTY path", () => {
    expect(wireText("later", "pty", { ...plain, agentRunning: true })).toBe(
      "/queue later",
    );
  });

  it("never prefixes natively — the gateway queues a mid-turn submit itself", async () => {
    // A native "/queue later" is not a command, it is a message whose text
    // begins with "/queue". The agent would answer that instead.
    const { transport, nativeCalls } = fakes({ submitOutcome: "queued" });
    await transport.send("later", { ...plain, agentRunning: true });
    expect(nativeCalls).toEqual([["submit", "later", undefined]]);
  });

  it("leaves slash commands and clarify answers unprefixed on both paths", () => {
    const running = { agentRunning: true, isSlashCommand: true, answeringClarify: false };
    expect(wireText("/model", "pty", running)).toBe("/model");
    expect(
      wireText("blue", "pty", {
        agentRunning: true,
        isSlashCommand: false,
        answeringClarify: true,
      }),
    ).toBe("blue");
  });

  it("resend never queues — a retry is the message, not a command", async () => {
    const { transport, ptyCalls } = fakes({ nativeActive: false });
    await transport.resend("later");
    expect(ptyCalls).toEqual([["sendText", "later"]]);
  });
});

describe("stop", () => {
  it("interrupts the native session instead of sending Ctrl-C to nothing", async () => {
    const { transport, nativeCalls, ptyCalls } = fakes();
    await transport.stop();
    expect(nativeCalls).toEqual([["interrupt"]]);
    expect(ptyCalls).toEqual([]);
  });

  it("still sends Ctrl-C on the terminal path", async () => {
    const { transport, ptyCalls } = fakes({ nativeActive: false });
    await transport.stop();
    expect(ptyCalls).toEqual([["sendRaw", "\x03"]]);
  });
});

describe("approvals", () => {
  it("sends the choice itself, not a menu digit", async () => {
    // The digit's meaning depends on how many rows the TUI drew. Natively
    // there is no menu to miscount.
    const { transport, nativeCalls, ptyCalls } = fakes();
    expect(await transport.approve("deny", { menuKey: "4" })).toBe(true);
    expect(nativeCalls).toEqual([["respondApproval", "deny", { all: false }]]);
    expect(ptyCalls).toEqual([]);
  });

  it("forwards an approve-all", async () => {
    const { transport, nativeCalls } = fakes();
    await transport.approve("always", { menuKey: "3", all: true });
    expect(nativeCalls).toEqual([["respondApproval", "always", { all: true }]]);
  });

  it("reports a rejected approval instead of resolving the card", async () => {
    const { transport } = fakes({ approvalThrows: true });
    expect(await transport.approve("once", { menuKey: "1" })).toBe(false);
  });

  it("still types the menu key on the terminal path", async () => {
    const { transport, ptyCalls } = fakes({ nativeActive: false });
    await transport.approve("deny", { menuKey: "4" });
    expect(ptyCalls).toEqual([["sendRaw", "4"]]);
  });
});

describe("clarify", () => {
  it("answers by request id, not by position", async () => {
    const { transport, nativeCalls } = fakes();
    const ok = await transport.clarify({
      answer: "blue",
      requestId: "req-7",
      choices: ["red", "blue"],
    });
    expect(ok).toBe(true);
    expect(nativeCalls).toEqual([["respondClarify", "req-7", "blue"]]);
  });

  it("refuses to answer natively without the request it answers", async () => {
    // A positional answer with no id could land on a question that arrived
    // between render and click.
    const { transport, nativeCalls } = fakes();
    expect(await transport.clarify({ answer: "blue", choices: ["red", "blue"] })).toBe(
      false,
    );
    expect(nativeCalls).toEqual([]);
  });

  it("still sends the 1-based index on the terminal path", async () => {
    const { transport, ptyCalls } = fakes({ nativeActive: false });
    await transport.clarify({ answer: "blue", choices: ["red", "blue"] });
    expect(ptyCalls).toEqual([["sendRaw", "2"]]);
  });

  it("routes free text as an answer, not as a new prompt", async () => {
    // The defect: natively the steering step was a no-op returning true, and
    // the text then went out as `prompt.submit` — so the question stayed open
    // and the answer arrived as an unrelated message.
    const { transport, nativeCalls } = fakes();
    const outcome = await transport.answerClarifyFreeText({
      answer: "something else",
      requestId: "req-9",
      choiceCount: 2,
    });
    expect(outcome).toBe("sent");
    expect(nativeCalls).toEqual([["respondClarify", "req-9", "something else"]]);
  });

  it("never sends free text as a prompt natively", async () => {
    const { transport, nativeCalls } = fakes();
    await transport.answerClarifyFreeText({
      answer: "x", requestId: "req-9", choiceCount: 1,
    });
    expect(nativeCalls.map((c) => c[0])).not.toContain("submit");
  });

  it("fails rather than guessing when there is no request to answer", async () => {
    const { transport, nativeCalls } = fakes();
    const outcome = await transport.answerClarifyFreeText({
      answer: "x", choiceCount: 1,
    });
    expect(outcome).toBe("failed");
    expect(nativeCalls).toEqual([]);
  });

  it("reports a rejected answer as failed", async () => {
    const { transport } = fakes({ clarifyThrows: true });
    expect(
      await transport.answerClarifyFreeText({
        answer: "x", requestId: "req-9", choiceCount: 1,
      }),
    ).toBe("failed");
  });

  it("still walks the terminal menu to Other and pastes the text", async () => {
    const { transport, ptyCalls } = fakes({ nativeActive: false });
    await transport.answerClarifyFreeText({
      answer: "something else", requestId: "req-9", choiceCount: 2,
    });
    expect(ptyCalls).toEqual([
      ["sendRaw", "\x1b[B\x1b[B"],
      ["sendRaw", "\r"],
      ["sendText", "something else"],
    ]);
  });
});

describe("composer readiness", () => {
  it("follows the native connection, not the terminal that never opens", () => {
    // The PTY state machine starts at "connecting" and, because native mode
    // never builds a terminal, stays there. A composer gated on it is disabled
    // for the entire life of a working native session.
    expect(
      composerReady({
        native: { active: true, status: "ready" },
        ptyOpen: false,
      }),
    ).toBe(true);
  });

  it("stays open while the agent is working so a message can be queued", () => {
    expect(
      composerReady({ native: { active: true, status: "working" }, ptyOpen: false }),
    ).toBe(true);
  });

  it("is closed before the native session is connected", () => {
    for (const status of ["idle", "connecting", "closed", "error"] as const) {
      expect(
        composerReady({ native: { active: true, status }, ptyOpen: true }),
      ).toBe(false);
    }
  });

  it("falls back to the terminal state when native chat is off", () => {
    expect(
      composerReady({ native: { active: false, status: "idle" }, ptyOpen: true }),
    ).toBe(true);
    expect(
      composerReady({ native: { active: false, status: "ready" }, ptyOpen: false }),
    ).toBe(false);
  });
});

describe("mode", () => {
  it("names the transport that owns the page", () => {
    expect(fakes().transport.mode()).toBe("native");
    expect(fakes({ nativeActive: false }).transport.mode()).toBe("pty");
  });

  it("is read per call, so flipping the flag takes effect without a rebuild", async () => {
    const native: NativeSide = {
      active: false,
      status: "ready",
      submit: async () => "accepted",
      interrupt: async () => {},
      respondApproval: async () => {},
      respondClarify: async () => {},
    };
    const pty: PtySide = {
      sendText: () => true,
      sendRaw: () => true,
      open: true,
      ended: false,
    };
    const transport = createChatTransport({ native: () => native, pty: () => pty });
    expect(transport.mode()).toBe("pty");
    native.active = true;
    expect(transport.mode()).toBe("native");
  });
});

describe("the idempotency key", () => {
  /**
   * A message whose acknowledgement was lost has an unknown fate. Without a
   * key the client must choose between dropping it and duplicating it; with
   * one it can resend and let the gateway decide which situation it is in.
   *
   * The key is the optimistic row's id because that id already identifies one
   * composed message across every attempt to deliver it. A fresh value per
   * attempt would make each retry a new prompt — the exact duplicate the key
   * exists to prevent.
   */
  it("travels with a native send", async () => {
    const { transport, nativeCalls } = fakes();
    await transport.send("hello", plain, "user-1");
    expect(nativeCalls).toContainEqual(["submit", "hello", "user-1"]);
  });

  it("travels with a resend, unchanged", async () => {
    const { transport, nativeCalls } = fakes();
    await transport.send("hello", plain, "user-1");
    await transport.resend("hello", "user-1");
    const tokens = nativeCalls
      .filter((c) => c[0] === "submit")
      .map((c) => c[2]);
    expect(tokens).toEqual(["user-1", "user-1"]);
  });

  it("is optional, so a caller without one still sends", async () => {
    const { transport, nativeCalls } = fakes();
    await transport.send("hello", plain);
    expect(nativeCalls).toContainEqual(["submit", "hello", undefined]);
  });

  it("is not sent down the terminal path, which has no notion of one", async () => {
    const { transport, ptyCalls } = fakes({ nativeActive: false });
    await transport.send("hello", plain, "user-1");
    expect(ptyCalls).toEqual([["sendText", "hello"]]);
  });
});
