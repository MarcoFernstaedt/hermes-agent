import { useCallback, useEffect, useRef, useState } from "react";
import { GatewayClient } from "@/lib/gatewayClient";
import {
  NativeChatSession,
  isNativeChatEnabled,
  type NativeChatStatus,
  type ResumedMessage,
  type SubmitOutcome,
} from "@/lib/nativeChat";
import {
  clearDurableSessionId,
  loadDurableSessionId,
  saveDurableSessionId,
} from "@/lib/nativeChatSessionStore";
import type { GatewayEvent } from "@hermes/shared";

/**
 * Owns the native chat session for the whole app.
 *
 * One instance, mounted by the persistent `ChatPage`, which the shell keeps
 * alive across every route — so the full page and the quick-chat overlay share
 * this session by construction rather than by synchronisation. There is no
 * second session to keep in step.
 *
 * The durable id is persisted the moment the gateway confirms it, so a refresh
 * resumes rather than creates. That is the difference between reattaching and
 * leaving a duplicate slash-worker behind on every reload.
 */
export interface NativeChat {
  /** True when this hook — not the PTY — is driving chat. */
  active: boolean;
  status: NativeChatStatus;
  /** Live transport session, for callers that need to scope something. */
  liveId: string | null;
  /** Durable session, stable across refresh. */
  durableId: string | null;
  submit(text: string): Promise<SubmitOutcome>;
  interrupt(): Promise<void>;
  respondApproval(
    choice: "once" | "session" | "always" | "deny",
    opts?: { all?: boolean },
  ): Promise<void>;
  respondClarify(requestId: string, answer: string): Promise<void>;
  /**
   * Close this session and open a genuinely new one.
   *
   * "New chat" used to rotate the PTY identity and clear the URL, which under
   * native chat changed nothing at all: the session stayed open, the durable
   * id stayed in storage, and the next prompt continued the old conversation
   * under a heading that said it was new.
   */
  startNew(): void;
  /** Try again after retries were exhausted. Visible, owner-initiated. */
  retry(): void;
  /**
   * True once bounded reconnect has given up. The caller must stop showing
   * held messages as "sending" — an optimistic row that never resolves is a
   * message the owner believes was delivered.
   */
  gaveUp: boolean;
  error: string | null;
}

/** Bounded: retrying forever hides a real outage behind a spinner. */
const MAX_RECONNECT_ATTEMPTS = 4;
const RECONNECT_BASE_MS = 500;

export function useNativeChat(
  onEvent: (event: GatewayEvent) => void,
  {
    enabled,
    profile = "default",
    onHistory,
  }: {
    enabled: boolean;
    profile?: string;
    /** The resumed transcript, delivered before any live event. */
    onHistory?: (messages: ResumedMessage[]) => void;
  },
): NativeChat {
  const active = enabled && isNativeChatEnabled();
  const [status, setStatus] = useState<NativeChatStatus>("idle");
  const [liveId, setLiveId] = useState<string | null>(null);
  const [durableId, setDurableId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped by `startNew`; a dependency of the open effect, so incrementing it
  // tears the session down and builds another.
  const [generation, setGeneration] = useState(0);
  const retryTimerRef = useRef<number | null>(null);
  // Set alongside it, and consumed by the effect: a deliberate new chat must
  // not resume the id it just discarded.
  const forceFreshRef = useRef(false);
  const [gaveUp, setGaveUp] = useState(false);
  const attemptRef = useRef(0);

  const sessionRef = useRef<NativeChatSession | null>(null);
  // The event sink is held in a ref so a re-created callback does not tear the
  // session down and rebuild it — reconnecting on every render would be the
  // duplicate-session bug by a different route.
  //
  // Updated in an effect rather than during render: a ref written during render
  // is not safe under concurrent rendering, where a render can be discarded and
  // would leave the ref pointing at a callback that never committed.
  const sinkRef = useRef(onEvent);
  useEffect(() => {
    sinkRef.current = onEvent;
  }, [onEvent]);
  const historyRef = useRef(onHistory);
  useEffect(() => {
    historyRef.current = onHistory;
  }, [onHistory]);

  useEffect(() => {
    if (!active) return;

    let disposed = false;
    const session = new NativeChatSession(new GatewayClient(), {
      onEvent: (ev) => sinkRef.current(ev),
      onHistory: (messages) => historyRef.current?.(messages),
      onStatusChange: (s) => {
        if (!disposed) setStatus(s);
      },
    });
    sessionRef.current = session;

    const fresh = forceFreshRef.current;
    forceFreshRef.current = false;

    void session
      .open(fresh ? null : loadDurableSessionId(profile))
      .then(() => {
        if (disposed) return;
        setLiveId(session.id);
        setDurableId(session.resumeId);
        // Persist only what the gateway confirmed. Writing a hoped-for id would
        // make the next load resume something that may never have existed.
        saveDurableSessionId(session.resumeId, profile);
        setError(null);
      })
      .then(() => {
        // A successful open clears the retry budget, so a later drop gets its
        // own full allowance rather than inheriting an exhausted one.
        attemptRef.current = 0;
        setGaveUp(false);
      })
      .catch((err: unknown) => {
        if (disposed) return;
        setError(err instanceof Error ? err.message : String(err));
        // Bounded reconnect. Retrying forever hides an outage behind a
        // spinner; not retrying at all leaves every held message showing
        // "sending" for the rest of the session, which is worse — the owner
        // believes it was delivered.
        //
        // Note this retries the *open*, never the send: a fresh session is not
        // a reason to re-run a prompt whose fate is unknown.
        if (attemptRef.current >= MAX_RECONNECT_ATTEMPTS) {
          setStatus("error");
          setGaveUp(true);
          return;
        }
        const delay = RECONNECT_BASE_MS * 2 ** attemptRef.current;
        attemptRef.current += 1;
        setStatus("reconnecting");
        retryTimerRef.current = window.setTimeout(() => {
          if (!disposed) setGeneration((n) => n + 1);
        }, delay);
      });

    return () => {
      disposed = true;
      if (retryTimerRef.current !== null) {
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      session.close();
      sessionRef.current = null;
    };
  }, [active, profile, generation]);

  const retry = useCallback(() => {
    attemptRef.current = 0;
    setGaveUp(false);
    setError(null);
    setStatus("connecting");
    setGeneration((n) => n + 1);
  }, []);

  const startNew = useCallback(() => {
    // Cleared *before* the rebuild so the effect cannot read a stale id, and
    // the live id is dropped immediately so nothing keeps addressing the old
    // session while the new one opens.
    clearDurableSessionId(profile);
    forceFreshRef.current = true;
    setLiveId(null);
    setDurableId(null);
    setError(null);
    setGeneration((n) => n + 1);
  }, [profile]);

  const submit = useCallback(async (text: string): Promise<SubmitOutcome> => {
    const session = sessionRef.current;
    if (!session) throw new Error("native chat is not connected");
    return session.submit(text);
  }, []);

  const interrupt = useCallback(async () => {
    await sessionRef.current?.interrupt();
  }, []);

  const respondApproval = useCallback(
    async (
      choice: "once" | "session" | "always" | "deny",
      opts?: { all?: boolean },
    ) => {
      const session = sessionRef.current;
      // Throwing rather than no-op'ing: the caller resolves the approval card
      // on success, and silently succeeding here would clear a card whose
      // decision never reached the agent.
      if (!session) throw new Error("native chat is not connected");
      await session.respondApproval(choice, opts);
    },
    [],
  );

  const respondClarify = useCallback(async (requestId: string, answer: string) => {
    const session = sessionRef.current;
    if (!session) throw new Error("native chat is not connected");
    await session.respondClarify(requestId, answer);
  }, []);

  return {
    active,
    status,
    liveId,
    durableId,
    submit,
    interrupt,
    respondApproval,
    respondClarify,
    startNew,
    retry,
    gaveUp,
    error,
  };
}
