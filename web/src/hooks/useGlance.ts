import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { AgentActivity } from "@/lib/glance";

/**
 * Feeds the shell's glance from the volatile context tier.
 *
 * Reuses `GET /api/system/context` — the same payload the agent pulls through
 * `hub_context` and the Now page renders. Three surfaces, one assembler: if the
 * glance counted blocking items its own way it would eventually disagree with
 * the page it links to, and the owner would not know which to believe.
 *
 * Polling rather than realtime, deliberately, until the item stream's
 * `item.resolved` broadcast lands in the next increment — a wrong-but-cheap
 * refresh beats a second event channel that has to be kept consistent with the
 * first. The interval is slow because nothing here is urgent: anything urgent
 * is a blocking item, and those toast.
 */
const POLL_MS = 60_000;

export interface GlanceState {
  blockingCount: number;
  activity: AgentActivity;
  toolName?: string;
  problems: string[];
}

export function useGlance(activity: AgentActivity = "idle", toolName?: string): GlanceState {
  const [blockingCount, setBlockingCount] = useState(0);
  const [problems, setProblems] = useState<string[]>([]);

  const refresh = useCallback(async (signal?: { cancelled: boolean }) => {
    try {
      const ctx = await api.getHubContext();
      if (signal?.cancelled) return;

      // Blocking means "Imperator cannot continue without you" — pending
      // approvals are exactly that. Opportunity and informational items are
      // deliberately excluded; counting them here would make the badge cry wolf.
      const pending = ctx.sections.review?.counts?.pending ?? 0;
      setBlockingCount(pending);

      const found: string[] = [];
      if (ctx.sections.guardrails?.halted) found.push("Agent halted");
      for (const p of ctx.sections.health?.problems ?? []) found.push(p);
      for (const [name, section] of Object.entries(ctx.sections)) {
        // A section that could not be read is itself a degradation worth
        // showing — silence would imply everything is fine.
        if (section && (section as { available?: boolean }).available === false) {
          found.push(`${name} unavailable`);
        }
      }
      setProblems(found);
    } catch {
      if (!signal?.cancelled) setProblems(["Hub context unreachable"]);
    }
  }, []);

  useEffect(() => {
    const signal = { cancelled: false };
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch; state lands after the await, not synchronously.
    void refresh(signal);
    const timer = window.setInterval(() => void refresh(signal), POLL_MS);
    return () => {
      signal.cancelled = true;
      window.clearInterval(timer);
    };
  }, [refresh]);

  return { blockingCount, activity, toolName, problems };
}
