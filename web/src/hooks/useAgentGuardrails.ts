import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { AgentGuardrails, AgentScope } from "@/lib/api";

const POLL_MS = 15_000;

/**
 * Live view of the server-enforced agent guardrails: the available session
 * scopes and whether the global stop is engaged. The stop is authoritative on
 * the server (enforced at the tool-dispatch chokepoint); this hook only
 * reflects and toggles it. We poll on a slow cadence so an engage/release made
 * elsewhere (another tab, the CLI) converges without a manual refresh.
 */
export function useAgentGuardrails() {
  const [scopes, setScopes] = useState<AgentScope[]>([]);
  const [defaultScope, setDefaultScope] = useState("full");
  const [halted, setHalted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

  const apply = useCallback((g: AgentGuardrails) => {
    setScopes(g.scopes);
    setDefaultScope(g.default_scope);
    setHalted(g.halted);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const g = await api.getAgentGuardrails();
      if (mounted.current) apply(g);
    } catch {
      /* transient — keep last-known state */
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [apply]);

  useEffect(() => {
    mounted.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch; setState lands after the await, not synchronously.
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => {
      mounted.current = false;
      clearInterval(id);
    };
  }, [refresh]);

  const setHalt = useCallback(
    async (next: boolean) => {
      setBusy(true);
      // Optimistic — the stop must feel instantaneous.
      setHalted(next);
      try {
        const res = await api.setAgentHalt(next);
        if (mounted.current) setHalted(res.halted);
      } catch {
        if (mounted.current) await refresh();
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [refresh],
  );

  return { scopes, defaultScope, halted, loading, busy, setHalt, refresh };
}
