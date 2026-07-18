import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import {
  BriefcaseBusiness,
  CheckCircle2,
  Download,
  ExternalLink,
  FileText,
  Search,
  Settings2,
} from "lucide-react";

import { api } from "@/lib/api";
import {
  JOB_STATUSES,
  commitJobStatus,
  statusLabel,
  type JobFreshness,
  type JobRole,
  type JobsFilters,
  type JobsSummary,
  type JobStatus,
} from "@/lib/jobs";
import { Badge } from "@nous-research/ui/ui/components/badge";
import { Button } from "@nous-research/ui/ui/components/button";
import { Card, CardContent } from "@nous-research/ui/ui/components/card";
import { Input } from "@nous-research/ui/ui/components/input";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { cn } from "@/lib/utils";

export type JobsViewState = "loading" | "ready" | "error" | "unconfigured";

interface JobsViewProps {
  state: JobsViewState;
  error?: string;
  summary: JobsSummary | null;
  roles: JobRole[];
  filters: JobsFilters;
  availableStatuses?: string[];
  availableLanes?: string[];
  announcement?: string;
  summaryStale?: boolean;
  pendingJobId?: number | null;
  updateError?: string;
  updateErrorJobId?: number | null;
  selectedStatuses?: Record<number, JobStatus>;
  onHeadingRef?: (jobId: number, element: HTMLHeadingElement | null) => void;
  onFiltersChange: (filters: JobsFilters) => void;
  onRetry: () => void;
  onSummaryRetry?: () => void;
  onStatusSelect: (jobId: number, status: JobStatus) => void;
  onStatusUpdate: (jobId: number, status?: JobStatus) => void;
  onAsset: (url: string, disposition: "inline" | "attachment", name: string) => void;
}

const SUMMARY_ITEMS: Array<[keyof JobsSummary["counts"], string]> = [
  ["total", "Total jobs"],
  ["packet_ready", "Packet ready — not applied"],
  ["applied", "Applied"],
  ["pending", "Pending response"],
  ["interviewing", "Interviewing"],
  ["rejected", "Rejected"],
  ["expired", "Expired / closed"],
  ["offer_received", "Offers"],
  ["offer_accepted", "Accepted offer"],
];

/** Accent per pipeline stage so the summary and cards read at a glance. */
const STATUS_TONES: Record<string, "success" | "warning" | "destructive" | "outline" | "secondary"> = {
  packet_ready_not_applied: "secondary",
  applied: "outline",
  pending: "outline",
  interviewing: "warning",
  rejected: "destructive",
  expired: "outline",
  offer_received: "success",
  offer_accepted: "success",
};

const SUMMARY_NUMBER_COLORS: Record<string, string> = {
  interviewing: "text-warning",
  offer_received: "text-success",
  offer_accepted: "text-success",
  rejected: "text-destructive",
};

function titleCase(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function GoalBar({ label, current, target }: { label: string; current: number; target: number }) {
  const pct = target > 0 ? Math.min(100, Math.round((current / target) * 100)) : 0;
  const met = target > 0 && current >= target;
  return (
    <Card className="p-3">
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="text-text-secondary">{label}</span>
        <span className={cn("font-mono-ui tabular-nums", met ? "text-success" : "text-foreground")}>
          {current} / {target}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuenow={current}
        aria-valuemin={0}
        aria-valuemax={target}
        className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-secondary/60"
      >
        <div
          className={cn("h-full rounded-full transition-all", met ? "bg-success" : "bg-primary")}
          style={{ width: `${pct}%` }}
        />
      </div>
    </Card>
  );
}

/**
 * The page is an apply workflow, not a flat list: ready packets queue in
 * "Up next", anything submitted tracks in "In motion", and terminal
 * statuses rest in "Closed". Updating a status re-groups immediately, so
 * marking a job applied visibly moves it out of the queue.
 */
const IN_MOTION = new Set(["applied", "pending", "interviewing", "offer_received", "offer_accepted"]);
const GROUPS = [
  { id: "queue", title: "Up next", hint: "Packet ready — apply and mark it" },
  { id: "motion", title: "In motion", hint: "Submitted and moving" },
  { id: "closed", title: "Closed", hint: "Rejected, withdrawn, expired" },
] as const;

function groupOf(role: JobRole): (typeof GROUPS)[number]["id"] {
  if (role.status === "packet_ready_not_applied") return "queue";
  if (IN_MOTION.has(role.status)) return "motion";
  return "closed";
}

const FRESHNESS_DOTS: Record<string, string> = {
  active: "bg-success",
  stale: "bg-warning",
  unknown: "bg-text-tertiary",
};

/** Native <select> (keeps aria-label + mobile pickers) in dashboard clothes. */
const SELECT_CN = cn(
  "min-h-11 w-full cursor-pointer border border-midground/15 bg-background/40 px-3",
  "font-courier text-sm text-midground transition-colors hover:border-midground/25",
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-midground/30",
  "disabled:cursor-not-allowed disabled:opacity-50",
);

const LINK_BUTTON_CN = cn(
  "inline-flex min-h-11 items-center gap-1.5 border border-current/25 px-3 py-2 text-sm",
  "text-text-secondary transition-colors hover:border-primary/50 hover:text-midground",
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-midground",
);

export function JobsView({
  state,
  error,
  summary,
  roles,
  filters,
  availableStatuses = [...JOB_STATUSES],
  availableLanes,
  announcement = "",
  summaryStale = false,
  pendingJobId = null,
  updateError,
  updateErrorJobId = null,
  selectedStatuses = {},
  onHeadingRef,
  onFiltersChange,
  onRetry,
  onSummaryRetry,
  onStatusSelect,
  onStatusUpdate,
  onAsset,
}: JobsViewProps) {
  const updateFilter = (key: keyof JobsFilters) => (
    event: ChangeEvent<HTMLInputElement | HTMLSelectElement>,
  ) => onFiltersChange({ ...filters, [key]: event.target.value });

  return (
    <section aria-labelledby="jobs-heading" className="mx-auto w-full max-w-6xl space-y-5 p-4 sm:p-6">
      <header>
        <h2 id="jobs-heading" className="sr-only">Jobs</h2>
      </header>
      <p className="sr-only" aria-live="polite">{announcement}</p>

      {state === "loading" && (
        <p role="status" className="flex items-center justify-center gap-2 py-16 text-sm text-text-secondary">
          <Spinner className="text-xl text-primary" />
          Loading jobs…
        </p>
      )}
      {state === "unconfigured" && (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <Settings2 className="size-6 text-text-disabled" />
            <p className="text-sm font-medium">Job tracking isn&apos;t configured yet.</p>
            <p className="max-w-md text-xs text-text-secondary">
              The tracker reads your job-search vault. Point{" "}
              <code className="font-mono-ui text-primary/90">HERMES_JOBS_DB_PATH</code> at the
              applications database and{" "}
              <code className="font-mono-ui text-primary/90">HERMES_JOBS_PACKET_ROOT</code> at the
              packet folder, then restart the dashboard.
            </p>
            <Button size="sm" outlined onClick={onRetry}>Check again</Button>
          </CardContent>
        </Card>
      )}
      {state === "error" && (
        <section role="alert" className="space-y-3 rounded border border-destructive/50 bg-destructive/[0.06] p-4">
          <p className="text-sm">{error || "Jobs could not load."}</p>
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex min-h-11 items-center border border-current/30 px-4 text-sm transition-colors hover:bg-midground/10"
          >Retry</button>
        </section>
      )}

      {state === "ready" && (
        <>
          {summary?.campaign_stop && (
            <p role="status" className="rounded border border-success/50 bg-success/10 p-3 text-sm font-medium text-success">
              Offer accepted. Campaign stop signal is active.
            </p>
          )}
          <section aria-labelledby="jobs-summary-heading">
            <h2 id="jobs-summary-heading" className="mb-3 text-base font-semibold tracking-wide">Pipeline</h2>
            {summaryStale && (
              <div role="status" className="mb-3 flex flex-wrap items-center gap-3 rounded border border-warning/40 bg-warning/5 p-3 text-sm">
                <span>Summary unavailable. Status counts may be stale.</span>
                <Button size="sm" outlined onClick={onSummaryRetry}>Reload summary</Button>
              </div>
            )}
            {summary && (
              <>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {SUMMARY_ITEMS.map(([key, label]) => (
                    <Card key={key} className="p-3">
                      <h3 className="text-xs tracking-wide text-text-secondary">{label}</h3>
                      <p className={cn("mt-1 text-2xl font-semibold tabular-nums", SUMMARY_NUMBER_COLORS[key] ?? "text-foreground")}>
                        {summary.counts[key]}
                      </p>
                    </Card>
                  ))}
                </div>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <GoalBar label="Agent today qualified" current={summary.agent_today_qualified.current} target={summary.agent_today_qualified.target} />
                  <GoalBar label="Your week applied" current={summary.your_week_applied.current} target={summary.your_week_applied.target} />
                </div>
              </>
            )}
          </section>

          <section aria-label="Job search filters" className="grid gap-3 rounded border border-current/15 bg-background-base/40 p-3 sm:grid-cols-4">
            <label className="grid gap-1 text-xs text-text-secondary">
              Search
              <span className="relative block">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-text-disabled" />
                <Input
                  type="search"
                  className="min-h-11 w-full pl-8"
                  value={filters.query}
                  onChange={updateFilter("query")}
                  placeholder="Company or role"
                />
              </span>
            </label>
            <label className="grid gap-1 text-xs text-text-secondary">
              Status
              <select className={SELECT_CN} value={filters.status} onChange={updateFilter("status")}>
                <option value="">All statuses</option>
                {availableStatuses.map((status) => (
                  <option key={status} value={status}>{statusLabel(status)}</option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-xs text-text-secondary">
              Lane
              <select className={SELECT_CN} value={filters.lane} onChange={updateFilter("lane")}>
                <option value="">All lanes</option>
                {(availableLanes || [...new Set(roles.map((role) => role.lane))].sort()).map((lane) => (
                  <option key={lane} value={lane}>{titleCase(lane)}</option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-xs text-text-secondary">
              Freshness
              <select className={SELECT_CN} value={filters.freshness} onChange={updateFilter("freshness")}>
                <option value="">Any freshness</option>
                {(["active", "stale", "unknown"] as JobFreshness[]).map((value) => (
                  <option key={value} value={value}>{titleCase(value)}</option>
                ))}
              </select>
            </label>
          </section>

          {roles.length === 0 ? (
            <Card>
              <CardContent role="status" className="flex flex-col items-center gap-2 py-10 text-center text-sm text-text-secondary">
                <BriefcaseBusiness className="size-6 text-text-disabled" />
                No roles found.
                <span className="text-xs text-text-tertiary">
                  Adjust the filters above, or wait for the next scouting run.
                </span>
              </CardContent>
            </Card>
          ) : (
            GROUPS.map((group) => {
              const groupRoles = roles.filter((role) => groupOf(role) === group.id);
              if (groupRoles.length === 0) return null;
              return (
                <section key={group.id} aria-labelledby={`jobs-${group.id}-heading`} data-snap-block>
                  <h2 id={`jobs-${group.id}-heading`} className="mb-1 text-base font-semibold tracking-wide">
                    {group.title} <span className="font-normal text-text-tertiary">({groupRoles.length})</span>
                  </h2>
                  <p className="mb-3 text-xs text-text-tertiary">{group.hint}</p>
                  <div className="grid gap-4 lg:grid-cols-2">
                    {groupRoles.map((role) => {
                      const label = `${role.role_title} at ${role.company}`;
                      const pending = pendingJobId === role.id;
                      const selectedStatus = selectedStatuses[role.id] || role.status;
                      const trackable = JOB_STATUSES.includes(role.status as JobStatus);
                      const inQueue = group.id === "queue";
                      return (
                        <Card key={role.id} data-snap-card className="flex scroll-mt-4 snap-start flex-col p-4" aria-labelledby={`job-${role.id}-heading`}>
                          <header className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <h3
                                ref={(element) => onHeadingRef?.(role.id, element)}
                                id={`job-${role.id}-heading`}
                                tabIndex={-1}
                                className="truncate font-semibold"
                              >{role.role_title}</h3>
                              <p className="truncate text-sm text-text-secondary">{role.company}</p>
                            </div>
                            <span
                              className={cn(
                                "shrink-0 rounded border px-2 py-1 text-sm font-mono-ui tabular-nums",
                                role.fit_score >= 80
                                  ? "border-success/40 text-success"
                                  : role.fit_score >= 60
                                    ? "border-warning/40 text-warning"
                                    : "border-current/25 text-text-secondary",
                              )}
                            >Fit {role.fit_score}</span>
                          </header>
                          <p className="mt-2 text-sm text-muted-foreground">
                            {role.location}
                            {role.work_mode && role.work_mode !== role.location ? ` · ${role.work_mode}` : ""}
                            {role.pay ? ` · ${role.pay}` : ""}
                          </p>
                          <p className="mt-1.5 flex flex-wrap items-center gap-2 text-sm">
                            <Badge tone={STATUS_TONES[role.status] ?? "outline"} className="text-xs">
                              {statusLabel(role.status)}
                            </Badge>
                            <span className="inline-flex items-center gap-1.5 text-xs text-text-secondary">
                              <span aria-hidden className={cn("size-1.5 rounded-full", FRESHNESS_DOTS[role.freshness] ?? "bg-text-tertiary")} />
                              {titleCase(role.freshness)} · Checked {role.checked_at?.slice(0, 10) || role.date_found}
                            </span>
                          </p>
                          <div className="mt-3 flex flex-wrap gap-2">
                            {/* Queue cards surface the packet inline: the whole
                                flow is open packet -> apply -> mark applied. */}
                            {inQueue && role.assets.map((asset) => (
                              <button key={asset.id} type="button" className={LINK_BUTTON_CN} onClick={() => onAsset(asset.open_url, "inline", asset.name)}>
                                <FileText className="size-3.5" />Open {asset.name}
                              </button>
                            ))}
                            {role.apply_url && (
                              <a className={LINK_BUTTON_CN} href={role.apply_url} target="_blank" rel="noopener noreferrer">
                                <ExternalLink className="size-3.5" />Open apply page
                              </a>
                            )}
                            {role.source_url && (
                              <a className={LINK_BUTTON_CN} href={role.source_url} target="_blank" rel="noopener noreferrer">
                                <ExternalLink className="size-3.5" />Open source
                              </a>
                            )}
                          </div>
                          {inQueue && (
                            <Button
                              aria-label={`Mark ${label} applied`}
                              className="mt-3 min-h-11 w-full sm:w-auto"
                              disabled={pending}
                              onClick={() => onStatusUpdate(role.id, "applied")}
                              prefix={<CheckCircle2 />}
                            >{pending ? "Updating…" : "Mark applied"}</Button>
                          )}
                          <details className="mt-3">
                            <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium text-text-secondary transition-colors hover:text-midground">
                              Details and packet
                            </summary>
                            <div className="space-y-3 border-l border-current/15 pl-3 text-sm">
                              <section><h4 className="text-xs tracking-wide text-text-tertiary uppercase">Fit</h4><p className="mt-0.5">{role.fit_rationale}</p></section>
                              {role.gaps.length > 0 && <section><h4 className="text-xs tracking-wide text-text-tertiary uppercase">Gaps</h4><ul className="mt-0.5 list-disc pl-5">{role.gaps.map((gap) => <li key={gap}>{gap}</li>)}</ul></section>}
                              {role.blockers.length > 0 && <section><h4 className="text-xs tracking-wide text-warning uppercase">Blockers</h4><ul className="mt-0.5 list-disc pl-5">{role.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul></section>}
                              <section><h4 className="text-xs tracking-wide text-text-tertiary uppercase">Next</h4><p className="mt-0.5">{role.recommended_action}</p></section>
                              <section>
                                <h4 className="text-xs tracking-wide text-text-tertiary uppercase">Packet</h4>
                                <div className="mt-1 flex flex-wrap gap-2">{role.assets.map((asset) => (
                                  <span key={asset.id} className="contents">
                                    <button type="button" className={LINK_BUTTON_CN} onClick={() => onAsset(asset.open_url, "inline", asset.name)}>
                                      <FileText className="size-3.5" />Open {asset.name}
                                    </button>
                                    <button type="button" className={LINK_BUTTON_CN} onClick={() => onAsset(asset.download_url, "attachment", asset.name)}>
                                      <Download className="size-3.5" />Download {asset.name}
                                    </button>
                                  </span>
                                ))}</div>
                              </section>
                            </div>
                          </details>
                          <div className="mt-auto grid gap-2 pt-4 sm:grid-cols-[1fr_auto] sm:items-end">
                            <label className="grid gap-1 text-xs text-text-secondary">
                              Status for {label}
                              <select
                                aria-label={`Status for ${label}`}
                                className={SELECT_CN}
                                value={selectedStatus}
                                disabled={pending || !trackable || role.status === "offer_accepted"}
                                onChange={(event) => onStatusSelect(role.id, event.target.value as JobStatus)}
                              >
                                {!trackable && <option value={role.status}>{statusLabel(role.status)}</option>}
                                {JOB_STATUSES.map((status) => (
                                  <option key={status} value={status}>{statusLabel(status)}</option>
                                ))}
                              </select>
                            </label>
                            <Button
                              aria-label={`Update status for ${label}`}
                              className="min-h-11"
                              disabled={pending || !trackable || role.status === "offer_accepted" || selectedStatus === role.status}
                              onClick={() => onStatusUpdate(role.id)}
                            >{pending ? "Updating…" : "Update status"}</Button>
                          </div>
                          {updateError && updateErrorJobId === role.id && <p role="alert" className="mt-2 text-sm text-destructive">{updateError}</p>}
                        </Card>
                      );
                    })}
                  </div>
                </section>
              );
            })
          )}
        </>
      )}
    </section>
  );
}

const EMPTY_FILTERS: JobsFilters = { status: "", lane: "", freshness: "", query: "" };

export default function JobsPage() {
  const [state, setState] = useState<JobsViewState>("loading");
  const [error, setError] = useState("");
  const [summary, setSummary] = useState<JobsSummary | null>(null);
  const [roles, setRoles] = useState<JobRole[]>([]);
  const [availableStatuses, setAvailableStatuses] = useState<string[]>([
    ...JOB_STATUSES,
  ]);
  const [availableLanes, setAvailableLanes] = useState<string[]>([]);
  const [filters, setFilters] = useState<JobsFilters>(EMPTY_FILTERS);
  const [selected, setSelected] = useState<Record<number, JobStatus>>({});
  const [pendingJobId, setPendingJobId] = useState<number | null>(null);
  const [updateError, setUpdateError] = useState("");
  const [updateErrorJobId, setUpdateErrorJobId] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [summaryStale, setSummaryStale] = useState(false);
  const headingRefs = useRef<Record<number, HTMLHeadingElement | null>>({});

  const load = useCallback(async () => {
    setState("loading");
    // The roles list is the page's core content; the summary is a
    // secondary readout. Fetch them independently so a flaky summary
    // (e.g. a 500) degrades to a "stale" banner instead of blanking the
    // whole pipeline the user came to work.
    const [listResult, summaryResult] = await Promise.allSettled([
      api.getJobs(filters),
      api.getJobsSummary(),
    ]);

    if (listResult.status === "rejected") {
      if (/not configured|503/i.test(String(listResult.reason))) {
        setState("unconfigured");
        return;
      }
      setError("Jobs could not load.");
      setState("error");
      return;
    }

    const list = listResult.value;
    setRoles(list.items);
    setAvailableStatuses(list.filters.statuses);
    setAvailableLanes(list.filters.lanes);
    setSelected(
      Object.fromEntries(
        list.items
          .filter((role) => JOB_STATUSES.includes(role.status as JobStatus))
          .map((role) => [role.id, role.status as JobStatus]),
      ),
    );

    if (summaryResult.status === "fulfilled") {
      setSummary(summaryResult.value);
      setSummaryStale(false);
    } else {
      setSummaryStale(true);
    }
    setState("ready");
  }, [filters]);

  useEffect(() => {
    // Debounced so search keystrokes coalesce into one request.
    const timer = window.setTimeout(() => void load(), 250);
    return () => window.clearTimeout(timer);
  }, [load]);

  // Mobile card-snap: the page scrolls inside the shared app <main>, so
  // scope snapping to the jobs route by toggling it on that ancestor here
  // (and only on small screens). `proximity` pulls the nearest card into
  // view once you scroll a little, without trapping the summary/filters at
  // the top the way `mandatory` would. scroll-padding clears the sticky
  // header so a snapped card isn't hidden under it.
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const main = rootRef.current?.closest("main");
    if (!main) return;
    const mql = window.matchMedia("(max-width: 1023px)");
    const apply = () => {
      if (mql.matches) {
        main.style.scrollSnapType = "y proximity";
        main.style.scrollPaddingTop = "4.5rem";
      } else {
        main.style.scrollSnapType = "";
        main.style.scrollPaddingTop = "";
      }
    };
    apply();
    mql.addEventListener("change", apply);
    return () => {
      mql.removeEventListener("change", apply);
      main.style.scrollSnapType = "";
      main.style.scrollPaddingTop = "";
    };
  }, []);

  const reloadSummary = async () => {
    try {
      setSummary(await api.getJobsSummary());
      setSummaryStale(false);
      setAnnouncement("Summary reloaded.");
    } catch {
      setSummaryStale(true);
      setAnnouncement("Summary remains unavailable.");
    }
  };


  const updateStatus = async (jobId: number, override?: JobStatus) => {
    const role = roles.find((item) => item.id === jobId);
    // An explicit target (the queue's "Mark applied" quick action) wins
    // over the per-card status <select>.
    const target = override ?? selected[jobId];
    if (!role || !target || target === role.status) return;
    setPendingJobId(jobId);
    setUpdateError("");
    setUpdateErrorJobId(null);
    try {
      const committed = await commitJobStatus(
        role,
        target,
        api.updateJobStatus,
        api.getJobsSummary,
      );
      setRoles((current) => current.map((item) => item.id === jobId ? committed.role : item));
      setSelected((current) => ({ ...current, [jobId]: committed.role.status as JobStatus }));
      if (committed.summary) setSummary(committed.summary);
      if (committed.summaryStale !== null) setSummaryStale(committed.summaryStale);
      if (committed.conflict) {
        setUpdateError("Status changed elsewhere. Review the current status and choose again.");
        setUpdateErrorJobId(jobId);
      }
      setAnnouncement(committed.announcement);
      requestAnimationFrame(() => headingRefs.current[jobId]?.focus());
    } catch {
      setSelected((current) => ({
        ...current,
        [jobId]: role.status as JobStatus,
      }));
      setUpdateError("Status was not updated.");
      setUpdateErrorJobId(jobId);
      setAnnouncement("Status was not updated.");
    } finally {
      setPendingJobId(null);
    }
  };

  const openAsset = async (url: string, disposition: "inline" | "attachment", name: string) => {
    try {
      const blob = await api.fetchJobAsset(url);
      const objectUrl = URL.createObjectURL(blob);
      if (disposition === "inline") window.open(objectUrl, "_blank", "noopener,noreferrer");
      else {
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = name;
        anchor.click();
      }
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch {
      setAnnouncement("Packet asset could not open.");
    }
  };

  return (
    <div ref={rootRef}>
      <JobsView
        state={state}
        error={error}
        summary={summary}
        roles={roles}
        filters={filters}
        availableStatuses={availableStatuses}
        availableLanes={availableLanes}
        announcement={announcement}
        summaryStale={summaryStale}
        pendingJobId={pendingJobId}
        updateError={updateError}
        updateErrorJobId={updateErrorJobId}
        selectedStatuses={selected}
        onHeadingRef={(jobId, element) => { headingRefs.current[jobId] = element; }}
        onFiltersChange={setFilters}
        onRetry={() => void load()}
        onSummaryRetry={() => void reloadSummary()}
        onStatusSelect={(jobId, status) => setSelected((current) => ({ ...current, [jobId]: status }))}
        onStatusUpdate={(jobId, status) => void updateStatus(jobId, status)}
        onAsset={(url, disposition, name) => void openAsset(url, disposition, name)}
      />
    </div>
  );
}
