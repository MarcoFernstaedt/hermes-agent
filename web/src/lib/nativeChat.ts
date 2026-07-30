/**
 * Native structured chat — the transport half, with no React and no PTY.
 *
 * Today's dashboard chat runs the Ink TUI inside a pseudo-terminal and types
 * into it: `sendPtyText()` drives `term.paste()`, and a hidden xterm instance
 * exists solely as an input engine. The bubble feed the owner actually sees is
 * already a projection of the gateway's structured event stream — so the
 * terminal is not rendering anything, it is only *hosting the session and
 * carrying keystrokes*. That hosting is what round-2 recon caught failing: a
 * cold checkout ran `npm install` inside the connect handler and hung for five
 * minutes, and every attach left workers behind.
 *
 * The locked architecture calls for a native structured client on the TUI
 * gateway instead. The pieces already exist: `/api/ws` speaks the same
 * newline-delimited JSON-RPC the Ink TUI drives over stdio, `session.create` /
 * `session.resume` / `prompt.submit` are ordinary methods on it, and the
 * gateway emits `message.delta`, `tool.start`, `approval.request` and the rest
 * under exactly the names `chat-feed-model`'s reducer already consumes. So the
 * reducer needs no changes at all — only the transport underneath it does.
 *
 * This module is that transport, deliberately kept free of React and of the
 * concrete `GatewayClient` so its behaviour is testable without a socket. It
 * is not yet wired into `ChatPage`: swapping a 2,400-line component's transport
 * unverified, on the surface the owner uses most, is how you turn one broken
 * path into two. It ships behind `isNativeChatEnabled()` so the on-machine
 * agent can exercise it against a real gateway first.
 */
import type { GatewayEvent, GatewayEventName } from "@hermes/shared";

/** The slice of a gateway client this controller needs — a seam for tests. */
export interface NativeChatTransport {
  connect(): Promise<void>;
  request<T>(method: string, params?: Record<string, unknown>): Promise<T>;
  on(event: GatewayEventName, handler: (ev: GatewayEvent) => void): () => void;
  close(): void;
}

export type NativeChatStatus =
  | "idle"
  | "connecting"
  | "ready"
  | "working"
  | "closed"
  | "error";

/** What the gateway did with a prompt. `queued` is a success, not a failure. */
export type SubmitOutcome = "accepted" | "queued" | "steered";

export interface NativeChatOptions {
  /** Every gateway event for *this* session, in arrival order. */
  onEvent(event: GatewayEvent): void;
  onStatusChange?(status: NativeChatStatus): void;
  /** Terminal-width hint the gateway uses for its own formatting. */
  cols?: number;
}

/** Events worth forwarding to the feed reducer. Anything else is gateway noise. */
const FORWARDED: GatewayEventName[] = [
  "message.start",
  "message.delta",
  "message.complete",
  "reasoning.delta",
  "tool.start",
  "tool.progress",
  "tool.generating",
  "tool.complete",
  "approval.request",
  "approval.resolved",
  "write_approval.request",
  "write_approval.resolved",
  "write_approval.failed",
  "clarify.request",
  "clarify.resolved",
  "error",
] as unknown as GatewayEventName[];

/**
 * The session an event belongs to, or null when it is gateway-wide.
 *
 * Accepts the wire spelling and the normalised one: `GatewayEvent.session_id`
 * is what the socket delivers, while some producers hand back an already
 * normalised `sessionId`. Reading only one of them is how the scope filter came
 * to be a no-op the first time.
 */
export function eventSessionId(ev: GatewayEvent): string | null {
  const raw = ev as { session_id?: unknown; sessionId?: unknown };
  const value = raw.session_id ?? raw.sessionId;
  return typeof value === "string" && value ? value : null;
}

export class NativeChatSession {
  /**
   * The live transport identity. Changes on every reconnect, and is what
   * `prompt.submit` and event filtering must use.
   */
  private liveId: string | null = null;
  /**
   * The durable identity. Survives the socket, and is the *only* thing
   * `session.resume` accepts.
   *
   * Keeping one field for both is the defect the real-gateway soak found:
   * resuming with a dead live sid returned "session not found", the fallback
   * silently created a second session, and a refresh cost a duplicate
   * slash-worker instead of reattaching.
   */
  private storedId: string | null = null;
  private status: NativeChatStatus = "idle";
  private unsubscribes: Array<() => void> = [];
  private closed = false;
  private readonly transport: NativeChatTransport;
  private readonly options: NativeChatOptions;

  constructor(transport: NativeChatTransport, options: NativeChatOptions) {
    this.transport = transport;
    this.options = options;
  }

  /** The live transport session. Use for prompts and event scoping. */
  get id(): string | null {
    return this.liveId;
  }

  /** The durable session to hand back to `open()` after a refresh. */
  get resumeId(): string | null {
    return this.storedId;
  }

  get state(): NativeChatStatus {
    return this.status;
  }

  private setStatus(next: NativeChatStatus): void {
    if (this.status === next) return;
    this.status = next;
    this.options.onStatusChange?.(next);
  }

  /**
   * Connect, then resume `resumeId` if given and create a session otherwise.
   *
   * Resume is tried *first* and falls back to create only when the gateway
   * rejects it. A browser refresh that always created a fresh session is the
   * documented cause of leaked slash-worker subprocesses (one per refresh) —
   * the gateway even carries an orphan reaper to mop them up. Preferring resume
   * means a reconnect reattaches the session that already exists.
   */
  async open(resumeId?: string | null): Promise<string> {
    if (this.closed) throw new Error("session is closed");
    this.setStatus("connecting");
    try {
      await this.transport.connect();

      if (resumeId) {
        try {
          const res = await this.transport.request<{
            session_id?: string;
            resumed?: string;
          }>("session.resume", {
            session_id: resumeId,
            cols: this.options.cols ?? 80,
          });
          // Resume hands back a *fresh* live sid; the durable id is the one we
          // asked with (echoed as `resumed`). Reusing the old live sid here
          // would scope events to a transport that no longer exists.
          if (res?.session_id) {
            this.liveId = res.session_id;
            this.storedId = res.resumed ?? resumeId;
          }
        } catch {
          // Genuinely gone — pruned, expired, or from another profile. Falling
          // back is right; failing would strand the owner on a dead id.
          this.liveId = null;
          this.storedId = null;
        }
      }

      if (!this.liveId) {
        const res = await this.transport.request<{
          session_id: string;
          stored_session_id?: string;
        }>("session.create", { cols: this.options.cols ?? 80 });
        if (!res?.session_id) throw new Error("gateway did not return a session id");
        this.liveId = res.session_id;
        // A gateway that omits the durable id leaves nothing to resume with;
        // recording the live one would guarantee a failed resume next refresh,
        // so leave it null and let the next open create honestly.
        this.storedId = res.stored_session_id ?? null;
      }

      this.subscribe();
      this.setStatus("ready");
      return this.liveId;
    } catch (err) {
      this.setStatus("error");
      throw err;
    }
  }

  /**
   * Forward this session's events, and only this session's.
   *
   * The gateway multiplexes every session over one socket. Without the id
   * filter, a second chat tab's deltas would be reduced into this feed's
   * bubbles — the kind of bug that looks like the model babbling rather than
   * like a transport fault.
   */
  private subscribe(): void {
    for (const name of FORWARDED) {
      this.unsubscribes.push(
        this.transport.on(name, (ev) => {
          if (this.closed) return;
          // The wire field is `session_id`. Reading a camelCase `sessionId`
          // here silently disabled the filter — every event looked unscoped and
          // was forwarded. `chat-feed-model` normalises to `sessionId` only
          // *after* parsing the frame, so this layer must use the wire name.
          const evSid = eventSessionId(ev);
          if (evSid && this.liveId && evSid !== this.liveId) return;
          if (name === "message.start") this.setStatus("working");
          if (name === "message.complete" || name === "error") this.setStatus("ready");
          this.options.onEvent(ev);
        }),
      );
    }
  }

  /**
   * Send a prompt. A mid-turn send is queued by the gateway rather than
   * rejected, so `queued` and `steered` are successful outcomes and the caller
   * should render the message as pending, not failed.
   */
  async submit(text: string): Promise<SubmitOutcome> {
    if (this.closed) throw new Error("session is closed");
    if (!this.liveId) throw new Error("session is not open");
    const body = text.trim();
    if (!body) throw new Error("nothing to send");

    const res = await this.transport.request<{ status?: string; queued?: boolean }>(
      "prompt.submit",
      { session_id: this.liveId, text: body },
    );
    // The gateway signals a mid-turn queue two ways depending on path: a
// `status` string from the busy-submit handler, and a `queued: true` flag on
    // the accepted response the real soak observed. Both mean the same thing to
    // a caller — the message will run — so both map to "queued".
    const status = res?.status;
    if (status === "queued" || res?.queued === true) return "queued";
    if (status === "steered") return "steered";
    this.setStatus("working");
    return "accepted";
  }

  /** Ask the gateway to wind down the live turn. Safe to call when idle. */
  async interrupt(): Promise<void> {
    if (this.closed || !this.liveId) return;
    try {
      await this.transport.request("session.interrupt", { session_id: this.liveId });
    } catch {
      // Interrupting an already-finished turn is not an error worth surfacing.
    }
  }

  /**
   * Detach. Idempotent, and safe to call from a React cleanup that may run
   * twice under StrictMode.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const off of this.unsubscribes) {
      try {
        off();
      } catch {
        /* a listener that fails to detach must not block the rest */
      }
    }
    this.unsubscribes = [];
    try {
      this.transport.close();
    } catch {
      /* already closed */
    }
    this.setStatus("closed");
  }
}

/**
 * Whether to drive chat natively instead of through the PTY.
 *
 * Off by default and read from localStorage, so the on-machine agent can turn
 * it on for a real gateway without a rebuild, and the owner's daily path stays
 * on the transport that currently works.
 */
export function isNativeChatEnabled(): boolean {
  try {
    return window.localStorage.getItem("imperator.nativeChat") === "on";
  } catch {
    // Private browsing, or storage disabled — the safe answer is the old path.
    return false;
  }
}
