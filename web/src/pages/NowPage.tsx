import { Fragment, useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowUpRight,
  CalendarClock,
  CheckCircle2,
  Inbox,
  OctagonX,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { api } from "@/lib/api";
import type { HubContext } from "@/lib/api";
import { projectOutcomes } from "@/lib/nowOutcomes";
import {
  gateSentence,
  visibleSections,
  type NowContent,
  type NowSectionId,
} from "@/lib/nowOrder";
import {
  readStoredOverride,
  resolveOverride,
  today as localDay,
  writeStoredOverride,
} from "@/lib/nowOverride";
import {
  WORK_STATE_LABEL,
  rankOutcomes,
  workStateFor,
} from "@/lib/outcomeRanking";
import { cn } from "@/lib/utils";

/**
 * Now — one screen that answers "what needs me?".
 *
 * This renders the *same* payload the agent pulls through its `hub_context`
 * tool. That is the point: if the dashboard computed "what needs attention"
 * separately from the agent, the two would drift and the owner would get
 * different answers to the same question depending on where they asked.
 *
 * Asked what a personal intelligence hub was still missing, the on-machine
 * agent answered: an income-first now surface — current mission, best next
 * action, deadline exceptions, blockers, and approval state in one place. The
 * ordering below is exactly that, worst-blocker first: a halted agent (nothing
 * can happen), then decisions only the owner can make, then income work, then
 * dates, then the app's own health.
 */
export default function NowPage() {
  const [data, setData] = useState<HubContext | null>(null);
  const [error, setError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      setData(await api.getHubContext());
      setError(false);
    } catch {
      setError(true);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch; state lands after the await, not synchronously.
    void load();
  }, [load]);

  return (
    <NowView data={data} error={error} refreshing={refreshing} onRefresh={() => void load(true)} />
  );
}

/** The rendering half, separated so it can be exercised without a network. */
export function NowView({
  data,
  error,
  refreshing,
  onRefresh,
}: {
  data: HubContext | null;
  error: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  // The top three, ranked from real projected state. `override` is Marco's
  // replacement and beats the score outright — the point of an override is
  // that his judgement wins, so the page must not quietly re-rank around it.
  //
  // Read from storage rather than starting at null. It was `useState(null)`,
  // so the override lasted exactly as long as the component: a refresh, a trip
  // to Progress and back, or the tab being restored from the background all
  // silently reinstated Imperator's suggestion. The owner made a decision, the
  // page acknowledged it, and then reversed it when they were not looking.
  const [storedOverride, setStoredOverride] = useState(readStoredOverride);
  const candidates = projectOutcomes(data);
  // Resolved against the candidates that actually exist right now, so a choice
  // about a review item that has since been answered stops suppressing the
  // suggestion for something still on the list.
  const override = resolveOverride(storedOverride, {
    day: localDay(),
    candidateIds: candidates.map((c) => c.id),
  });
  const ranking = rankOutcomes(candidates, { overrideId: override });

  const chooseOverride = (id: string | null) => {
    writeStoredOverride(id);
    setStoredOverride(id === null ? null : { day: localDay(), id });
  };

  const progress = data?.sections.progress;
  // The order Now is read in comes from `nowOrder`, which existed as data with
  // nothing rendering from it. For a screen-reader user the reading order *is*
  // the design, so leaving it implied by JSX nesting meant any later layout
  // refactor could change what Marco hears first with no test noticing.
  const nowContent: NowContent = {
    outcome: ranking.top.find((i) => i.recommended)?.title ?? null,
    routines: progress?.available ? (progress.routines ?? null) : null,
    incomeGate: progress?.available && progress.income_gate
      ? { met: progress.income_gate.open, label: "Income gate" }
      : null,
    exception: data?.sections.guardrails?.halted
      ? { summary: data.sections.guardrails.note, actionRequired: true }
      : null,
  };
  const routineLine = gateSentence(nowContent);

  const jobs = data?.sections.jobs;
  const review = data?.sections.review;
  const guardrails = data?.sections.guardrails;
  const capabilities = data?.sections.capabilities;
  const health = data?.sections.health;

  /** The sections `nowOrder` knows about, keyed by id so it can order them. */
  const orderedSections: Partial<Record<NowSectionId, React.ReactNode>> = {
    outcome: (
            <section
              aria-labelledby="outcomes-h"
              data-now-section="outcome"
              className="flex flex-col gap-2"
            >
              <h3 id="outcomes-h" className="text-sm font-semibold text-midground">
                Today&rsquo;s three
                {ranking.consideredCount > ranking.top.length && (
                  <span className="ml-2 font-normal text-text-tertiary">
                    {ranking.top.length} of {ranking.consideredCount}
                  </span>
                )}
              </h3>
              <ul className="flex flex-col gap-2">
                {ranking.top.map((item) => {
                  const state = workStateFor(item);
                  return (
                    <li
                      key={item.id}
                      className={cn(
                        "rounded-lg border px-4 py-3 text-sm",
                        item.recommended
                          ? "border-primary/40 bg-primary/10"
                          : "border-current/10",
                      )}
                    >
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className="font-medium text-foreground">{item.title}</span>
                        {/* Words, not a colour: the recommendation has to be
                            announced, not merely tinted. */}
                        {item.recommended && (
                          <span className="rounded border border-primary/40 px-1.5 py-0.5 text-xs text-primary">
                            Imperator suggests starting here
                          </span>
                        )}
                      </div>
                      {/* Why it ranked where it did. A recommendation the owner
                          cannot interrogate is obeyed without thought or
                          ignored entirely. */}
                      <p className="mt-1 text-xs text-text-secondary">{item.why}</p>
                      <p className="mt-1 text-xs text-text-tertiary">
                        {WORK_STATE_LABEL[state]}
                      </p>
                      {!item.recommended && (
                        <button
                          type="button"
                          onClick={() => chooseOverride(item.id)}
                          className="mt-2 rounded-md border border-current/20 px-2 py-1 text-xs text-text-secondary hover:text-midground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-midground/40"
                        >
                          Start with this instead
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
              {override && (
                <button
                  type="button"
                  onClick={() => chooseOverride(null)}
                  className="self-start rounded-md border border-current/20 px-2 py-1 text-xs text-text-secondary hover:text-midground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-midground/40"
                >
                  Use Imperator&rsquo;s suggestion again
                </button>
              )}
            </section>
    ),
    gate: (
            <section
              aria-labelledby="gate-h"
              data-now-section="gate"
              className="flex flex-col gap-1 rounded-lg border border-current/10 px-4 py-3"
            >
              <h3 id="gate-h" className="text-sm font-semibold text-midground">
                Routines and income
              </h3>
              <p className="text-xs text-text-secondary">{routineLine}</p>
              {progress?.intention && (
                /* The owner's own words about today, from last night's
                   reflection. Never synthesised: absent when unwritten. */
                <p className="mt-1 text-xs text-text-tertiary">
                  Last night you wrote: {progress.intention}
                </p>
              )}
              <Link
                to="/progress"
                className="self-start text-xs text-text-tertiary underline-offset-2 hover:text-midground hover:underline"
              >
                Progress
              </Link>
            </section>
    ),
  };

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 p-4 sm:p-6">
      <header className="flex flex-wrap items-baseline gap-3">
        <h2 className="text-lg font-semibold">Now</h2>
        {data && (
          <span className="font-mono-ui text-xs text-text-tertiary">
            as of {new Date(data.generated_at).toLocaleTimeString()}
          </span>
        )}
        <button
          type="button"
          onClick={onRefresh}
          className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-current/15 px-2.5 py-1 font-sans text-xs text-text-secondary transition-colors hover:text-midground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-midground/40"
        >
          <RefreshCw
            className={cn("size-3.5", refreshing && "animate-spin motion-reduce:animate-none")}
            aria-hidden
          />
          Refresh
        </button>
      </header>

      {error ? (
        <p role="alert" className="rounded-lg border border-current/10 p-6 text-sm text-text-tertiary">
          Context unavailable on this runtime.
        </p>
      ) : !data ? (
        <div className="flex items-center justify-center gap-2 p-10 text-sm text-text-secondary">
          <Spinner /> Reading the current state…
        </div>
      ) : (
        <>
          {/* Rendered in the order `nowOrder` declares, not the order these
              happen to be written in. For a screen-reader user the reading
              order *is* the design, so leaving it implied by JSX nesting meant
              a later layout refactor could change what Marco hears first and
              no test would notice. `visibleSections` also drops anything with
              nothing to say — an absent thing is absent, not an empty card
              that costs a heading and a swipe to discover it says nothing. */}
          {visibleSections(nowContent).map((section) => (
            <Fragment key={section.id}>{orderedSections[section.id]}</Fragment>
          ))}

          {/* The lead. Everything below is the evidence behind these lines. */}
          <section aria-labelledby="attention-h" className="flex flex-col gap-2">
            <h2 id="attention-h" className="sr-only">
              What needs your attention
            </h2>
            <ul className="flex flex-col gap-2">
              {data.attention.map((line, i) => (
                <li
                  key={i}
                  className={cn(
                    "motion-enter rounded-lg border px-4 py-3 text-sm leading-relaxed",
                    "transition-[transform,opacity] duration-[var(--motion-move)] ease-[var(--ease-spring)]",
                    i === 0
                      ? "border-primary/40 bg-primary/10 font-medium text-foreground"
                      : "border-current/10 text-text-secondary",
                  )}
                  style={{ animationDelay: `${Math.min(i, 5) * 30}ms` }}
                >
                  {line}
                </li>
              ))}
            </ul>
          </section>

          {guardrails?.halted && (
            <Panel
              tone="destructive"
              icon={<OctagonX className="size-4 shrink-0" aria-hidden />}
              title="The agent is halted"
              action={{ to: "/settings", label: "Settings" }}
            >
              <p className="text-xs leading-relaxed">{guardrails.note}</p>
            </Panel>
          )}

          {(review?.pending?.length ?? 0) > 0 && (
            <Panel
              icon={<Inbox className="size-4 shrink-0" aria-hidden />}
              title={`${review!.counts?.pending ?? review!.pending.length} waiting on you`}
              action={{ to: "/review", label: "Review queue" }}
            >
              <ul className="flex flex-col gap-1.5">
                {review!.pending.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-baseline gap-2 text-xs">
                    <span className="rounded bg-midground/10 px-1.5 py-0.5 font-mono-ui uppercase tracking-[0.08em] text-text-secondary">
                      {p.kind}
                    </span>
                    <span className="text-text-secondary">{p.title}</span>
                    {p.risk !== "low" && (
                      <span className="text-warning">{p.risk} risk</span>
                    )}
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          {jobs?.available && (jobs.next_actions?.length ?? 0) > 0 && (
            <Panel
              icon={<ArrowUpRight className="size-4 shrink-0" aria-hidden />}
              title="Ready to send"
              action={{ to: "/jobs", label: "All jobs" }}
            >
              <ul className="flex flex-col gap-1.5">
                {jobs.next_actions.map((job) => (
                  <li key={job.id} className="flex flex-wrap items-baseline gap-2 text-xs">
                    <span className="font-medium text-text-secondary">{job.role}</span>
                    <span className="text-text-tertiary">at {job.company}</span>
                    {typeof job.fit_score === "number" && (
                      <span className="font-mono-ui tabular-nums text-text-tertiary">
                        fit {job.fit_score}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          {(capabilities?.due_or_overdue?.length ?? 0) > 0 && (
            <Panel
              tone="warning"
              icon={<CalendarClock className="size-4 shrink-0" aria-hidden />}
              title="Due or overdue"
            >
              <ul className="flex flex-col gap-1.5">
                {capabilities!.due_or_overdue.map((item, i) => (
                  <li key={i} className="flex flex-wrap items-baseline gap-2 text-xs">
                    <span className="font-mono-ui tabular-nums text-warning">{item.date}</span>
                    <span className="text-text-secondary">{item.title}</span>
                    <span className="text-text-tertiary">in {item.capability}</span>
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          {health && health.status !== "ok" && (health.problems?.length ?? 0) > 0 && (
            <Panel
              tone="warning"
              icon={<TriangleAlert className="size-4 shrink-0" aria-hidden />}
              title="Platform health"
              action={{ to: "/settings", label: "System" }}
            >
              <ul className="flex flex-col gap-1 text-xs text-text-secondary">
                {health.problems.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </Panel>
          )}

          {/* Unavailable sections are stated, not hidden: "no jobs shown"
              because the vault is unconfigured is a different fact from
              "nothing to apply to", and conflating them is a lie of omission. */}
          <UnavailableNote data={data} />
        </>
      )}
    </div>
  );
}

function Panel({
  icon,
  title,
  tone,
  action,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  tone?: "warning" | "destructive";
  action?: { to: string; label: string };
  children: React.ReactNode;
}) {
  return (
    <section
      className={cn(
        "flex flex-col gap-2 rounded-lg border p-3",
        tone === "destructive"
          ? "border-destructive/40 bg-destructive/5 text-destructive"
          : tone === "warning"
            ? "border-warning/40 bg-warning/5 text-warning"
            : "border-current/10",
      )}
    >
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        {icon}
        {title}
        {action && (
          <Link
            to={action.to}
            className="ml-auto font-sans text-xs font-normal text-text-tertiary underline-offset-2 transition-colors hover:text-midground hover:underline"
          >
            {action.label}
          </Link>
        )}
      </h2>
      {children}
    </section>
  );
}

function UnavailableNote({ data }: { data: HubContext }) {
  const missing = Object.entries(data.sections)
    .filter(([, s]) => s && (s as { available?: boolean }).available === false)
    .map(([name, s]) => `${name} (${(s as { reason?: string }).reason ?? "unavailable"})`);
  if (missing.length === 0) {
    return (
      <p className="flex items-center gap-2 text-xs text-text-tertiary">
        <CheckCircle2 className="size-3.5 text-success" aria-hidden />
        Every source reported in.
      </p>
    );
  }
  return (
    <p className="text-xs text-text-tertiary">Not included: {missing.join(", ")}.</p>
  );
}
