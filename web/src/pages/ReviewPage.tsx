import { useState } from "react";
import { Link } from "react-router-dom";
import { Check, ChevronDown, Inbox, ShieldAlert, Wand2, X } from "lucide-react";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { cn } from "@/lib/utils";
import { useReviewQueue } from "@/hooks/useReviewQueue";
import type { ReviewProposal } from "@/lib/api";

/**
 * The review queue — the single gated inbox. Every proposal the agent or the
 * platform files (add a capability, a skill, an MCP server, a fix) lands here;
 * nothing it describes happens until it is approved. Approving applies it and
 * shows the outcome. Fully keyboard operable; the risk and source of each
 * proposal are legible before any decision.
 */
export default function ReviewPage() {
  const { proposals, counts, loading, busyId, act } = useReviewQueue("pending");

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4 sm:p-6">
      <header className="flex items-center gap-2">
        <Inbox className="size-5 text-midground" aria-hidden />
        <h1 className="text-lg font-semibold">Review queue</h1>
        <span className="ml-auto font-mono-ui text-xs text-text-tertiary">
          {(counts.pending ?? 0)} pending · {(counts.applied ?? 0)} applied
        </span>
        <Link
          to="/capabilities/new"
          className="inline-flex items-center gap-1 rounded-md border border-current/15 px-2.5 py-1 font-sans text-xs text-text-secondary transition-colors hover:text-midground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-midground/40"
        >
          <Wand2 className="size-3.5" aria-hidden /> New capability
        </Link>
      </header>

      <p className="text-sm text-text-secondary">
        Proposals from the agent and the platform. Nothing here has happened yet —
        approving applies it, rejecting discards it. You are always the one who decides.
      </p>

      {loading ? (
        <div className="flex items-center justify-center gap-2 p-10 text-sm text-text-secondary">
          <Spinner /> Loading…
        </div>
      ) : proposals.length === 0 ? (
        <div className="rounded-lg border border-current/10 p-10 text-center text-sm text-text-tertiary">
          Nothing to review. The queue is clear.
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {proposals.map((p) => (
            <ProposalCard key={p.id} proposal={p} busy={busyId === p.id} onAct={act} />
          ))}
        </ul>
      )}
    </div>
  );
}

const RISK_TONE: Record<string, string> = {
  low: "text-text-tertiary",
  medium: "text-warning",
  high: "text-destructive",
};

function ProposalCard({
  proposal,
  busy,
  onAct,
}: {
  proposal: ReviewProposal;
  busy: boolean;
  onAct: (id: string, action: "approve" | "reject") => void;
}) {
  const [open, setOpen] = useState(false);
  const payloadText = JSON.stringify(proposal.payload, null, 2);

  return (
    <li className="rounded-lg border border-current/10 bg-midground/[0.02]">
      <div className="flex flex-wrap items-start gap-3 p-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded bg-midground/10 px-1.5 py-0.5 font-mono-ui text-[0.68rem] uppercase tracking-[0.08em] text-text-secondary">
              {proposal.kind}
            </span>
            <span className="font-sans text-sm font-medium text-text-primary">{proposal.title}</span>
            {proposal.risk !== "low" && (
              <span className={cn("inline-flex items-center gap-1 text-xs", RISK_TONE[proposal.risk])}>
                <ShieldAlert className="size-3.5" aria-hidden /> {proposal.risk} risk
              </span>
            )}
          </div>
          {proposal.summary && (
            <p className="font-sans text-xs text-text-secondary">{proposal.summary}</p>
          )}
          <span className="font-sans text-[0.68rem] text-text-tertiary">
            from {proposal.source}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => onAct(proposal.id, "reject")}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded-md border border-current/15 px-2.5 py-1 font-sans text-xs text-text-secondary transition-colors hover:text-destructive focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-destructive/40 disabled:opacity-50"
          >
            <X className="size-3.5" aria-hidden /> Reject
          </button>
          <button
            type="button"
            onClick={() => onAct(proposal.id, "approve")}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded-md bg-midground/90 px-2.5 py-1 font-sans text-xs text-background transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-midground/50 disabled:opacity-50"
          >
            <Check className="size-3.5" aria-hidden /> Approve
          </button>
        </div>
      </div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1 border-t border-current/10 px-3 py-1.5 text-left font-sans text-[0.68rem] text-text-tertiary hover:text-text-secondary"
      >
        <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} aria-hidden />
        {open ? "Hide" : "Inspect"} exactly what will happen
      </button>
      {open && (
        <pre className="max-h-72 overflow-auto border-t border-current/10 bg-background/40 p-3 font-mono-ui text-[0.7rem] leading-relaxed text-text-secondary">
          {payloadText}
        </pre>
      )}
    </li>
  );
}
