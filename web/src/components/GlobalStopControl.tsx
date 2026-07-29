import { OctagonX, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAgentGuardrails } from "@/hooks/useAgentGuardrails";

/**
 * The global stop — an always-reachable brake on all agent tool activity.
 * Engaging it flips a server-side flag that `agent_scopes.enforce_dispatch`
 * consults at the one chokepoint every tool call passes through, so a halted
 * agent is *refused*, not merely asked to stop. Lives in the sidebar so it is
 * reachable from every surface without hunting through settings.
 */
export function GlobalStopControl({ collapsed = false }: { collapsed?: boolean }) {
  const { halted, loading, busy, setHalt } = useAgentGuardrails();

  if (loading) return null;

  if (halted) {
    return (
      <div className={cn("px-3 pb-2", collapsed && "px-2")}>
        <button
          type="button"
          onClick={() => setHalt(false)}
          disabled={busy}
          aria-label="Resume the agent"
          title="Agent halted — click to resume"
          className={cn(
            "flex w-full items-center gap-2 rounded-md",
            "border border-destructive/40 bg-destructive/10",
            "px-3 py-2 text-left",
            "text-destructive transition-colors hover:bg-destructive/15",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-destructive/50",
            "disabled:opacity-60",
            collapsed && "justify-center px-2",
          )}
        >
          <Play className="size-4 shrink-0" aria-hidden />
          {!collapsed && (
            <span className="flex flex-col leading-tight">
              <span className="font-sans text-xs font-semibold tracking-[0.08em]">
                Agent halted
              </span>
              <span className="font-sans text-xs text-destructive/80">
                All tools paused · resume
              </span>
            </span>
          )}
        </button>
      </div>
    );
  }

  return (
    <div className={cn("px-3 pb-2", collapsed && "px-2")}>
      <button
        type="button"
        onClick={() => setHalt(true)}
        disabled={busy}
        aria-label="Stop the agent — pause all tool activity"
        title="Stop the agent — pause all tool activity"
        className={cn(
          "flex w-full items-center gap-2 rounded-md",
          "border border-current/10",
          "px-3 py-2 text-left",
          "text-text-secondary transition-colors",
          "hover:border-destructive/30 hover:text-destructive",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-destructive/40",
          "disabled:opacity-60",
          collapsed && "justify-center px-2",
        )}
      >
        <OctagonX className="size-4 shrink-0" aria-hidden />
        {!collapsed && (
          <span className="font-sans text-xs tracking-[0.08em]">Stop agent</span>
        )}
      </button>
    </div>
  );
}
