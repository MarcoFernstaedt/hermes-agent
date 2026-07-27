import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { ProposalStatus, ReviewProposal } from "@/lib/api";

const POLL_MS = 12_000;

/**
 * The review queue: pending proposals plus per-status counts. Polls on a slow
 * cadence so a proposal filed by the agent (or the platform) converges without a
 * manual refresh; `act` approves/rejects and refreshes optimistically.
 */
export function useReviewQueue(status: ProposalStatus | undefined = "pending") {
  const [proposals, setProposals] = useState<ReviewProposal[]>([]);
  const [counts, setCounts] = useState<Partial<Record<ProposalStatus, number>>>({});
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const res = await api.getReviewQueue(status);
      if (!mounted.current) return;
      setProposals(res.proposals);
      setCounts(res.counts);
    } catch {
      /* keep last-known */
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    mounted.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch; state lands after the await.
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => {
      mounted.current = false;
      clearInterval(id);
    };
  }, [refresh]);

  const act = useCallback(
    async (id: string, action: "approve" | "reject") => {
      setBusyId(id);
      try {
        if (action === "approve") await api.approveProposal(id);
        else await api.rejectProposal(id);
        await refresh();
      } finally {
        if (mounted.current) setBusyId(null);
      }
    },
    [refresh],
  );

  return { proposals, counts, loading, busyId, act, refresh };
}
