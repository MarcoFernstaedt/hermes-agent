import { useCallback, useEffect, useRef, useState } from "react";
import { GatewayClient } from "@/lib/gatewayClient";
import {
  NativeChatSession,
  isNativeChatEnabled,
  type NativeChatStatus,
  type SubmitOutcome,
} from "@/lib/nativeChat";
import {
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
  error: string | null;
}

export function useNativeChat(
  onEvent: (event: GatewayEvent) => void,
  { enabled, profile = "default" }: { enabled: boolean; profile?: string },
): NativeChat {
  const active = enabled && isNativeChatEnabled();
  const [status, setStatus] = useState<NativeChatStatus>("idle");
  const [liveId, setLiveId] = useState<string | null>(null);
  const [durableId, setDurableId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  useEffect(() => {
    if (!active) return;

    let disposed = false;
    const session = new NativeChatSession(new GatewayClient(), {
      onEvent: (ev) => sinkRef.current(ev),
      onStatusChange: (s) => {
        if (!disposed) setStatus(s);
      },
    });
    sessionRef.current = session;

    void session
      .open(loadDurableSessionId(profile))
      .then(() => {
        if (disposed) return;
        setLiveId(session.id);
        setDurableId(session.resumeId);
        // Persist only what the gateway confirmed. Writing a hoped-for id would
        // make the next load resume something that may never have existed.
        saveDurableSessionId(session.resumeId, profile);
        setError(null);
      })
      .catch((err: unknown) => {
        if (disposed) return;
        // A failed open is reported, not retried into a fresh session — the
        // narrow-fallback rule holds here too.
        setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      disposed = true;
      session.close();
      sessionRef.current = null;
    };
  }, [active, profile]);

  const submit = useCallback(async (text: string): Promise<SubmitOutcome> => {
    const session = sessionRef.current;
    if (!session) throw new Error("native chat is not connected");
    return session.submit(text);
  }, []);

  const interrupt = useCallback(async () => {
    await sessionRef.current?.interrupt();
  }, []);

  return { active, status, liveId, durableId, submit, interrupt, error };
}
