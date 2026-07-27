import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Select, SelectOption } from "@nous-research/ui/ui/components/select";
import { api } from "@/lib/api";
import type { AgentScope } from "@/lib/api";

/**
 * Per-session capability scope, shown and changeable from the chat header.
 * The scope is server-enforced at the tool-dispatch chokepoint (a scoped-out
 * tool is refused, not hidden), so this control is the visible surface of a
 * real guarantee — not a hint. Reads the session's current scope, lets you
 * switch it, and persists optimistically.
 */
export function ChatScopeControl({ sessionId }: { sessionId: string }) {
  const [scopes, setScopes] = useState<AgentScope[]>([]);
  const [scope, setScope] = useState<string>("full");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([api.getAgentGuardrails(), api.getSessionScope(sessionId)])
      .then(([g, s]) => {
        if (!alive) return;
        setScopes(g.scopes);
        setScope(s.scope);
        setReady(true);
      })
      .catch(() => alive && setReady(true));
    return () => {
      alive = false;
    };
  }, [sessionId]);

  if (!ready || scopes.length === 0) return null;

  const active = scopes.find((s) => s.name === scope);
  const nonDefault = scope !== "full";

  const change = async (next: string) => {
    const previous = scope;
    setScope(next); // optimistic
    try {
      const res = await api.setSessionScope(sessionId, next);
      setScope(res.scope);
    } catch {
      setScope(previous); // rollback
    }
  };

  return (
    <label
      className="inline-flex items-center gap-1.5"
      title={active ? active.description : "Agent capability scope for this chat"}
    >
      <span className="sr-only">Agent capability scope for this chat</span>
      <ShieldCheck
        className={cnScopeIcon(nonDefault)}
        aria-hidden
      />
      <Select
        value={scope}
        onValueChange={change}
        aria-label="Agent capability scope"
        className="h-7 min-h-0 w-auto border-none bg-transparent px-1 py-0 text-xs text-text-secondary shadow-none"
      >
        {scopes.map((s) => (
          <SelectOption key={s.name} value={s.name}>
            {s.label}
          </SelectOption>
        ))}
      </Select>
    </label>
  );
}

function cnScopeIcon(nonDefault: boolean): string {
  return nonDefault
    ? "size-3.5 shrink-0 text-warning"
    : "size-3.5 shrink-0 text-text-tertiary";
}
