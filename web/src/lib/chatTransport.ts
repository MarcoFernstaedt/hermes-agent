/**
 * Which transport carries a chat action — and what changes when it is native.
 *
 * `ChatPage` had exactly one native seam: the terminal was not constructed when
 * native mode was on. Everything the owner actually *does* — send, stop, retry,
 * approve, answer a clarify — still went through `sendPtyText()` and raw
 * control bytes into a socket that native mode had deliberately never opened.
 * So the flag turned chat off rather than turning it native, which is why the
 * acceptance run found a page that connected and then could not send.
 *
 * This module is that routing, extracted from the component so it can be
 * exercised. Not because a helper is tidier, but because the defect was
 * invisible in a 2,600-line effect-heavy component and is obvious here: every
 * action names the transport it goes to, and a test can watch which one
 * received it.
 *
 * Three differences are real behaviour changes, not translations:
 *
 * **Mid-run sends.** The PTY path prefixes `/queue ` so the TUI's own command
 * queues the message server-side. The gateway's `prompt.submit` already returns
 * `queued` for a mid-turn submit, so prefixing natively would send the literal
 * text "/queue …" as a message.
 *
 * **Approvals.** The terminal answered by typing a menu digit whose meaning
 * depends on how many rows the TUI drew. `approval.respond` takes the choice
 * itself, so "deny" cannot arrive as "always allow" because a list was shorter
 * than expected.
 *
 * **Clarify.** The terminal sent arrow keys and a positional index.
 * `clarify.respond` addresses the request by id, so an answer cannot land on a
 * different question that arrived between render and click.
 */
import type { NativeChatStatus, SubmitOutcome } from "@/lib/nativeChat";

/** What happened to a message the owner submitted. */
export type SendOutcome =
  /** On the wire, running now. */
  | "sent"
  /** Accepted and will run after the current turn. Success, not failure. */
  | "queued"
  /** Nothing was delivered. The caller must not render this as sent. */
  | "failed";

export type ApprovalChoice = "once" | "session" | "always" | "deny";

/** The native session, as this module needs it. Mirrors `useNativeChat`. */
export interface NativeSide {
  active: boolean;
  status: NativeChatStatus;
  submit(text: string): Promise<SubmitOutcome>;
  interrupt(): Promise<void>;
  respondApproval(choice: ApprovalChoice, opts?: { all?: boolean }): Promise<void>;
  respondClarify(requestId: string, answer: string): Promise<void>;
}

/** The terminal path, as this module needs it. */
export interface PtySide {
  /** `term.paste()` + Enter. False when the socket is not open. */
  sendText(text: string): boolean;
  /** Raw bytes — control codes and menu keys. False when not open. */
  sendRaw(bytes: string): boolean;
  /** True when the socket is open and accepting input. */
  open: boolean;
  /** True when the session is over and no reconnect will bring it back. */
  ended: boolean;
}

export interface ChatTransportSources {
  native(): NativeSide;
  pty(): PtySide;
}

export interface SendContext {
  /** The agent is mid-turn. */
  agentRunning: boolean;
  isSlashCommand: boolean;
  /** This message is the free-form answer to an open clarify question. */
  answeringClarify: boolean;
}

/**
 * Is the composer allowed to send right now?
 *
 * Under native chat this must read the native connection, not `ptyState`. The
 * PTY state machine starts at `"connecting"` and, because native mode never
 * opens a terminal, stays there forever — so a composer gated on
 * `ptyState !== "open"` is disabled for the entire life of a working native
 * session. That is the whole of the failed acceptance run in one expression.
 */
export function composerReady(args: {
  native: Pick<NativeSide, "active" | "status">;
  ptyOpen: boolean;
}): boolean {
  if (args.native.active) {
    // `working` is ready: a mid-turn message is queued by the gateway, and
    // refusing to accept it would make the composer feel broken during exactly
    // the moments the owner most wants to add something.
    return args.native.status === "ready" || args.native.status === "working";
  }
  return args.ptyOpen;
}

/**
 * The text actually put on the wire for a send.
 *
 * Exported because the `/queue` prefix is the one place the two transports
 * disagree about the *content* rather than the route, and a wrong answer here
 * is silent: the owner sees their message, the agent sees "/queue ..." and
 * replies to a command that means nothing to it.
 */
export function wireText(
  text: string,
  mode: "native" | "pty",
  ctx: SendContext,
): string {
  if (mode === "native") return text;
  if (ctx.answeringClarify || ctx.isSlashCommand || !ctx.agentRunning) return text;
  return `/queue ${text}`;
}

export interface ChatTransport {
  /** "native" when the native session owns this page's chat, else "pty". */
  mode(): "native" | "pty";
  ready(): boolean;
  send(text: string, ctx: SendContext): Promise<SendOutcome>;
  /** A plain resend with no queue semantics — retry and queue-flush use this. */
  resend(text: string): Promise<SendOutcome>;
  stop(): Promise<void>;
  approve(
    choice: ApprovalChoice,
    opts: { menuKey: string; all?: boolean },
  ): Promise<boolean>;
  clarify(opts: {
    answer: string;
    requestId?: string;
    /** Offered choices, for the terminal path's positional answer. */
    choices?: string[];
  }): Promise<boolean>;
  /**
   * Steer into an open clarify's "Other" option so free text can follow.
   * Terminal-only: natively the free text *is* the answer.
   */
  openClarifyFreeText(choiceCount: number): boolean;
}

export function createChatTransport(sources: ChatTransportSources): ChatTransport {
  const mode = (): "native" | "pty" =>
    sources.native().active ? "native" : "pty";

  const ptySend = (text: string): SendOutcome =>
    sources.pty().sendText(text) ? "sent" : "failed";

  const nativeSend = async (text: string): Promise<SendOutcome> => {
    try {
      const outcome = await sources.native().submit(text);
      // `queued` and `steered` both mean the gateway accepted it and it will
      // run. Only a throw means nothing was delivered.
      return outcome === "queued" ? "queued" : "sent";
    } catch {
      return "failed";
    }
  };

  return {
    mode,

    ready: () =>
      composerReady({ native: sources.native(), ptyOpen: sources.pty().open }),

    async send(text, ctx) {
      if (mode() === "native") return nativeSend(text);
      return ptySend(wireText(text, "pty", ctx));
    },

    async resend(text) {
      if (mode() === "native") return nativeSend(text);
      return ptySend(text);
    },

    async stop() {
      if (mode() === "native") {
        await sources.native().interrupt();
        return;
      }
      // Ctrl-C. The terminal has no other way to say "stop".
      sources.pty().sendRaw("\x03");
    },

    async approve(choice, { menuKey, all = false }) {
      if (mode() === "native") {
        try {
          await sources.native().respondApproval(choice, { all });
          return true;
        } catch {
          return false;
        }
      }
      return sources.pty().sendRaw(menuKey);
    },

    async clarify({ answer, requestId, choices }) {
      if (mode() === "native") {
        if (!requestId) return false;
        try {
          await sources.native().respondClarify(requestId, answer);
          return true;
        } catch {
          return false;
        }
      }
      const index = choices?.indexOf(answer) ?? -1;
      if (index < 0) return false;
      return sources.pty().sendRaw(String(index + 1));
    },

    openClarifyFreeText(choiceCount) {
      if (mode() === "native") return true;
      const pty = sources.pty();
      if (!pty.open) return false;
      // Walk to the last entry ("Other"), select it, and let the caller paste.
      return (
        pty.sendRaw("\x1b[B".repeat(choiceCount)) && pty.sendRaw("\r")
      );
    },
  };
}
