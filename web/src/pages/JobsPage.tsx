import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
} from "react";

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

export type JobsViewState = "loading" | "ready" | "error";

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
  onStatusUpdate: (jobId: number) => void;
  onAsset: (url: string, disposition: "inline" | "attachment", name: string) => void;
}

const SUMMARY_ITEMS: Array<[keyof JobsSummary["counts"], string]> = [
  ["qualified_packet_ready", "Packet ready"],
  ["applied", "Applied"],
  ["pending", "Pending response"],
  ["interviewing", "Interviewing"],
  ["rejected", "Rejected"],
  ["expired", "Expired / closed"],
  ["offer_received", "Offers"],
  ["offer_accepted", "Accepted offer"],
];

function titleCase(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

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

      {state === "loading" && <p role="status">Loading jobs…</p>}
      {state === "error" && (
        <section role="alert" className="space-y-3 rounded border border-destructive p-4">
          <p>{error || "Jobs could not load."}</p>
          <button type="button" onClick={onRetry} className="min-h-11 rounded border px-4">Retry</button>
        </section>
      )}

      {state === "ready" && summary && (
        <>
          {summary.campaign_stop && (
            <p role="status" className="rounded border border-emerald-600 p-3 font-medium">
              Offer accepted. Campaign stop signal is active.
            </p>
          )}
          <section aria-labelledby="jobs-summary-heading">
            <h2 id="jobs-summary-heading" className="mb-3 text-lg font-semibold">Summary</h2>
            {summaryStale && (
              <div role="status" className="mb-3 flex flex-wrap items-center gap-3 rounded border border-border p-3">
                <span>Summary unavailable. Status counts may be stale.</span>
                <button type="button" onClick={onSummaryRetry} className="min-h-11 rounded border px-4">Reload summary</button>
              </div>
            )}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {SUMMARY_ITEMS.map(([key, label]) => (
                <article key={key} className="rounded border border-border p-3">
                  <h3 className="text-sm text-muted-foreground">{label}</h3>
                  <p className="text-2xl font-semibold">{summary.counts[key]}</p>
                </article>
              ))}
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="rounded border border-border p-3">
                <span className="flex justify-between"><span>Today prepared</span><span>{summary.today_prepared.current} / {summary.today_prepared.target}</span></span>
                <progress className="mt-2 w-full" value={summary.today_prepared.current} max={summary.today_prepared.target} />
              </label>
              <label className="rounded border border-border p-3">
                <span className="flex justify-between"><span>Week applied</span><span>{summary.week_applied.current} / {summary.week_applied.target}</span></span>
                <progress className="mt-2 w-full" value={summary.week_applied.current} max={summary.week_applied.target} />
              </label>
            </div>
          </section>

          <section aria-label="Job search filters" className="grid gap-3 rounded border border-border p-3 sm:grid-cols-4">
            <label className="grid gap-1 text-sm">
              Search
              <input className="min-h-11 rounded border border-border bg-background px-3" type="search" value={filters.query} onChange={updateFilter("query")} />
            </label>
            <label className="grid gap-1 text-sm">
              Status
              <select className="min-h-11 rounded border border-border bg-background px-3" value={filters.status} onChange={updateFilter("status")}>
                <option value="">All statuses</option>
                {availableStatuses.map((status) => <option key={status} value={status}>{statusLabel(status)}</option>)}
              </select>
            </label>
            <label className="grid gap-1 text-sm">
              Lane
              <select className="min-h-11 rounded border border-border bg-background px-3" value={filters.lane} onChange={updateFilter("lane")}>
                <option value="">All lanes</option>
                {(availableLanes || [...new Set(roles.map((role) => role.lane))].sort()).map((lane) => <option key={lane} value={lane}>{titleCase(lane)}</option>)}
              </select>
            </label>
            <label className="grid gap-1 text-sm">
              Freshness
              <select className="min-h-11 rounded border border-border bg-background px-3" value={filters.freshness} onChange={updateFilter("freshness")}>
                <option value="">Any freshness</option>
                {(["active", "stale", "unknown"] as JobFreshness[]).map((value) => <option key={value} value={value}>{titleCase(value)}</option>)}
              </select>
            </label>
          </section>

          {roles.length === 0 ? (
            <p role="status" className="rounded border border-border p-5">No roles found.</p>
          ) : (
            <section aria-labelledby="roles-heading">
              <h2 id="roles-heading" className="mb-3 text-lg font-semibold">Roles</h2>
              <div className="grid gap-4 lg:grid-cols-2">
                {roles.map((role) => {
                  const label = `${role.role_title} at ${role.company}`;
                  const pending = pendingJobId === role.id;
                  const selectedStatus = selectedStatuses[role.id] || role.status;
                  const trackable = JOB_STATUSES.includes(role.status as JobStatus);
                  return (
                    <article key={role.id} className="rounded border border-border p-4" aria-labelledby={`job-${role.id}-heading`}>
                      <header className="flex items-start justify-between gap-3">
                        <div>
                          <h3 ref={(element) => onHeadingRef?.(role.id, element)} id={`job-${role.id}-heading`} tabIndex={-1} className="font-semibold">{role.role_title}</h3>
                          <p>{role.company}</p>
                        </div>
                        <span className="rounded border border-border px-2 py-1 text-sm">Fit {role.fit_score}</span>
                      </header>
                      <p className="mt-2 text-sm text-muted-foreground">
                        {role.location} · {role.work_mode}{role.pay ? ` · ${role.pay}` : ""}
                      </p>
                      <p className="mt-1 text-sm">
                        {titleCase(role.freshness)} · Checked {role.checked_at?.slice(0, 10) || role.date_found}
                      </p>
                      <p className="mt-1 font-medium">{statusLabel(role.status)}</p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {role.apply_url && <a className="min-h-11 rounded border border-border px-3 py-2" href={role.apply_url} target="_blank" rel="noopener noreferrer">Open apply page</a>}
                        {role.source_url && <a className="min-h-11 rounded border border-border px-3 py-2" href={role.source_url} target="_blank" rel="noopener noreferrer">Open source</a>}
                      </div>
                      <details className="mt-3">
                        <summary className="min-h-11 cursor-pointer py-2 font-medium">Details and packet</summary>
                        <div className="space-y-3 text-sm">
                          <section><h4 className="font-medium">Fit</h4><p>{role.fit_rationale}</p></section>
                          {role.gaps.length > 0 && <section><h4 className="font-medium">Gaps</h4><ul className="list-disc pl-5">{role.gaps.map((gap) => <li key={gap}>{gap}</li>)}</ul></section>}
                          {role.blockers.length > 0 && <section><h4 className="font-medium">Blockers</h4><ul className="list-disc pl-5">{role.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul></section>}
                          <section><h4 className="font-medium">Next</h4><p>{role.recommended_action}</p></section>
                          <section><h4 className="font-medium">Packet</h4><div className="flex flex-wrap gap-2">{role.assets.map((asset) => (
                            <span key={asset.id} className="contents">
                              <button type="button" className="min-h-11 rounded border border-border px-3" onClick={() => onAsset(asset.open_url, "inline", asset.name)}>Open {asset.name}</button>
                              <button type="button" className="min-h-11 rounded border border-border px-3" onClick={() => onAsset(asset.download_url, "attachment", asset.name)}>Download {asset.name}</button>
                            </span>
                          ))}</div></section>
                        </div>
                      </details>
                      <div className="mt-4 grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
                        <label className="grid gap-1 text-sm">
                          Status for {label}
                          <select aria-label={`Status for ${label}`} className="min-h-11 rounded border border-border bg-background px-3" value={selectedStatus} disabled={pending || !trackable || role.status === "offer_accepted"} onChange={(event) => onStatusSelect(role.id, event.target.value as JobStatus)}>
                            {!trackable && <option value={role.status}>{statusLabel(role.status)}</option>}
                            {JOB_STATUSES.map((status) => <option key={status} value={status}>{statusLabel(status)}</option>)}
                          </select>
                        </label>
                        <button type="button" aria-label={`Update status for ${label}`} className="min-h-11 rounded bg-primary px-4 text-primary-foreground disabled:opacity-50" disabled={pending || !trackable || role.status === "offer_accepted" || selectedStatus === role.status} onClick={() => onStatusUpdate(role.id)}>{pending ? "Updating…" : "Update status"}</button>
                      </div>
                      {updateError && updateErrorJobId === role.id && <p role="alert" className="mt-2 text-destructive">{updateError}</p>}
                    </article>
                  );
                })}
              </div>
            </section>
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
    try {
      const [list, nextSummary] = await Promise.all([
        api.getJobs(filters),
        api.getJobsSummary(),
      ]);
      setRoles(list.items);
      setSummary(nextSummary);
      setSummaryStale(false);
      setAvailableStatuses(list.filters.statuses);
      setAvailableLanes(list.filters.lanes);
      setSelected(
        Object.fromEntries(
          list.items
            .filter((role) => JOB_STATUSES.includes(role.status as JobStatus))
            .map((role) => [role.id, role.status as JobStatus]),
        ),
      );
      setState("ready");
    } catch {
      setError("Jobs could not load.");
      setState("error");
    }
  }, [filters]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

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


  const updateStatus = async (jobId: number) => {
    const role = roles.find((item) => item.id === jobId);
    const target = selected[jobId];
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
    <div>
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
        onStatusUpdate={(jobId) => void updateStatus(jobId)}
        onAsset={(url, disposition, name) => void openAsset(url, disposition, name)}
      />
    </div>
  );
}
