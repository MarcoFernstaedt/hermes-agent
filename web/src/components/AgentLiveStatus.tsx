import { useEffect, useRef, useState } from "react";

export type AgentState = "idle" | "working" | "reconnecting";

/**
 * A visually-hidden polite live region that announces Imperator's run state
 * to assistive technology. The visible status pill in the composer conveys
 * the same thing to sighted users, but a `role="status"` on a pill that also
 * holds a pulsing dot re-announces noisily on every toggle. This element
 * instead announces only *settled* transitions — "Imperator is working",
 * "Imperator finished responding", "Connection lost, reconnecting" — so a
 * screen-reader user always knows what the agent is doing without the churn,
 * even when focus is in the composer rather than the transcript.
 *
 * The first render is intentionally silent (no announcement for the initial
 * idle state), and transitions are debounced so a brief reconnect blip or a
 * fast tool round-trip doesn't stutter the announcement.
 */
export function AgentLiveStatus({ state }: { state: AgentState }) {
  const [message, setMessage] = useState("");
  const settledRef = useRef<AgentState>(state);
  const firstRef = useRef(true);

  useEffect(() => {
    // Skip announcing the state the component mounted in.
    if (firstRef.current) {
      firstRef.current = false;
      settledRef.current = state;
      return;
    }
    const timer = setTimeout(() => {
      if (settledRef.current === state) return;
      settledRef.current = state;
      setMessage(
        state === "working"
          ? "Imperator is working"
          : state === "reconnecting"
            ? "Connection lost, reconnecting"
            : "Imperator finished responding",
      );
    }, 350);
    return () => clearTimeout(timer);
  }, [state]);

  return (
    <span aria-live="polite" role="status" className="sr-only">
      {message}
    </span>
  );
}
