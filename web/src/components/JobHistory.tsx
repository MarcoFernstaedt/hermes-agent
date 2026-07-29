import { useState } from "react";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { ArrowRight, ChevronDown, ChevronRight, History } from "lucide-react";

import { api } from "@/lib/api";
import { useData } from "@/lib/use-data";
import { statusLabel } from "@/lib/jobs";
import { cn } from "@/lib/utils";

/**
 * A collapsible stage-history timeline for one job. Lazy-loads the recorded
 * status transitions (newest first) from /api/jobs/:id/history only when
 * expanded, so a long list of cards stays cheap.
 */
export function JobHistory({ jobId }: { jobId: number }) {
  const [open, setOpen] = useState(false);
  const hist = useData(
    open ? `jobs:history:${jobId}` : null,
    () => api.getJobHistory(jobId),
  );
  const events = hist.data?.events ?? [];

  return (
    <div className="mt-3 border-t border-border pt-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={cn(
          "flex items-center gap-1.5 text-xs font-medium text-text-secondary",
          "transition-colors hover:text-foreground",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/40",
        )}
      >
        {open ? (
          <ChevronDown className="size-3.5" aria-hidden />
        ) : (
          <ChevronRight className="size-3.5" aria-hidden />
        )}
        <History className="size-3.5" aria-hidden />
        Stage history
      </button>

      {open && (
        <div className="mt-2">
          {hist.isLoading ? (
            <div className="flex items-center gap-2 text-xs text-text-tertiary">
              <Spinner /> Loading…
            </div>
          ) : events.length === 0 ? (
            <p className="text-xs text-text-tertiary">
              No stage changes recorded yet.
            </p>
          ) : (
            <ol className="flex flex-col gap-2">
              {events.map((e, i) => (
                <li key={`${e.changed_at}-${i}`} className="flex items-start gap-2">
                  <span
                    aria-hidden
                    className="mt-1 size-1.5 shrink-0 rounded-full bg-primary"
                  />
                  <div className="min-w-0 text-xs">
                    <span className="flex flex-wrap items-center gap-1 text-foreground">
                      <span className="text-text-tertiary">
                        {statusLabel(e.from_status)}
                      </span>
                      <ArrowRight className="size-3 text-text-tertiary" aria-hidden />
                      <span className="font-medium">{statusLabel(e.to_status)}</span>
                    </span>
                    <time className="text-text-tertiary" dateTime={e.changed_at}>
                      {formatWhen(e.changed_at)}
                    </time>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}

/** Absolute date + time for a transition; falls back to the raw value. */
function formatWhen(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
