import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, Sunrise, Target } from "lucide-react";
import { api } from "@/lib/api";
import {
  commitJobStatus,
  loadJobs,
  selectDailyActions,
  type JobRole,
  type JobsSummary,
} from "@/lib/jobs";
import { cn } from "@/lib/utils";

/**
 * The daily command surface: the highest-value income actions right now —
 * roles whose application packet is built and only needs submitting. Each is
 * one action from progress: open the application, then mark it applied. Leads
 * the Jobs page so the morning starts on "what moves money", not a filter grid.
 * Fully keyboard/screen-reader operable; hides itself when there is no ready work.
 */
export function JobsTodayCommand() {
  const [actions, setActions] = useState<JobRole[] | null>(null);
  const [summary, setSummary] = useState<JobsSummary | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [announce, setAnnounce] = useState("");
  const mounted = useRef(true);

  const load = useCallback(async () => {
    // The actions are the point of this surface; the week counter is a footnote.
    // `Promise.all` rejected on either, so a failing summary blanked the whole
    // command strip — the one thing on the page that moves money.
    await loadJobs(
      api.getJobs({ status: "packet_ready_not_applied", lane: "", freshness: "", query: "" }),
      api.getJobsSummary(),
      {
        onList: (list) => {
          if (mounted.current) setActions(selectDailyActions(list.items));
        },
        onReady: () => {},
        onSummary: (sum) => {
          if (mounted.current && sum) setSummary(sum);
        },
        onError: () => {
          if (mounted.current) setActions([]);
        },
      },
    );
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  const markApplied = useCallback(
    async (role: JobRole) => {
      setBusyId(role.id);
      try {
        const result = await commitJobStatus(role, "applied", api.updateJobStatus, api.getJobsSummary);
        if (!mounted.current) return;
        if (result.conflict) {
          setAnnounce(result.announcement);
          void load(); // re-sync — it changed elsewhere.
          return;
        }
        setActions((prev) => (prev ? prev.filter((j) => j.id !== role.id) : prev));
        if (result.summary) setSummary(result.summary);
        setAnnounce(`Marked ${role.company} — ${role.role_title} as applied.`);
      } catch {
        if (mounted.current) setAnnounce("Could not update status. Try again.");
      } finally {
        if (mounted.current) setBusyId(null);
      }
    },
    [load],
  );

  // Nothing loaded yet, or no ready work — stay out of the way.
  if (actions === null || actions.length === 0) return null;

  const week = summary?.your_week_applied;

  return (
    <section
      aria-labelledby="jobs-today-heading"
      className="flex flex-col gap-3 rounded-xl border border-current/10 bg-midground/[0.03] p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2
          id="jobs-today-heading"
          className="flex items-center gap-2 font-sans text-sm font-semibold tracking-[0.06em] text-text-secondary"
        >
          <Sunrise className="size-4 text-warning" aria-hidden />
          Today — ready to apply
        </h2>
        {week ? (
          <span className="inline-flex items-center gap-1.5 font-mono-ui text-xs text-text-tertiary">
            <Target className="size-3.5" aria-hidden />
            <span className="tabular-nums">{week.current}</span> applied this week
          </span>
        ) : null}
      </div>

      <ol className="flex flex-col gap-2">
        {actions.map((role, i) => {
          const applyHref = role.apply_url || role.source_url || undefined;
          return (
            <li
              key={role.id}
              className={cn(
                "flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg",
                "border border-current/10 bg-background/40 px-3 py-2.5",
              )}
            >
              <span
                className="flex size-6 shrink-0 items-center justify-center rounded-full bg-midground/10 font-mono-ui text-xs tabular-nums text-text-secondary"
                aria-hidden
              >
                {i + 1}
              </span>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-sans text-sm text-text-primary">
                  {role.company} — {role.role_title}
                </span>
                <span className="truncate font-sans text-xs text-text-tertiary">
                  fit {role.fit_score} · {role.location || role.work_mode || role.lane}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {applyHref ? (
                  <a
                    href={applyHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cn(
                      "inline-flex items-center gap-1 rounded-md border border-current/15 px-2.5 py-1",
                      "font-sans text-xs text-text-secondary transition-colors hover:text-midground",
                      "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-midground/40",
                    )}
                  >
                    Open application
                    <ArrowUpRight className="size-3.5" aria-hidden />
                  </a>
                ) : null}
                <button
                  type="button"
                  onClick={() => void markApplied(role)}
                  disabled={busyId === role.id}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-md px-2.5 py-1",
                    "bg-midground/90 font-sans text-xs text-background transition-opacity",
                    "hover:opacity-90 disabled:opacity-50",
                    "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-midground/50",
                  )}
                >
                  <Check className="size-3.5" aria-hidden />
                  Mark applied
                </button>
              </div>
            </li>
          );
        })}
      </ol>

      <p aria-live="polite" className="sr-only">
        {announce}
      </p>
    </section>
  );
}
