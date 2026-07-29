export const JOB_STATUSES = [
  "packet_ready_not_applied",
  "applied",
  "pending",
  "interviewing",
  "rejected",
  "withdrawn",
  "duplicate",
  "expired",
  "offer_received",
  "offer_accepted",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];
export type JobFreshness = "active" | "stale" | "unknown";

export interface JobAsset {
  id: number;
  type: string;
  name: string;
  media_type: string;
  download_url: string;
  open_url: string;
}

export interface JobRole {
  id: number;
  company: string;
  role_title: string;
  lane: string;
  location: string;
  work_mode: string;
  pay: string | null;
  source_url: string | null;
  apply_url: string | null;
  requisition_id: string | null;
  date_found: string;
  fit_score: number;
  verdict: string;
  fit_rationale: string;
  gaps: string[];
  blockers: string[];
  recommended_action: string;
  status: string;
  updated_at: string;
  applied_at: string | null;
  checked_at: string | null;
  freshness: JobFreshness;
  assets: JobAsset[];
}

export interface JobsFilters {
  status: string;
  lane: string;
  freshness: JobFreshness | "";
  query: string;
}

export interface JobsListResponse {
  items: JobRole[];
  total: number;
  filters: {
    statuses: string[];
    lanes: string[];
    freshness: JobFreshness[];
  };
}

export interface JobsSummary {
  counts: {
    total: number;
    packet_ready: number;
    applied: number;
    pending: number;
    interviewing: number;
    rejected: number;
    expired: number;
    offer_received: number;
    offer_accepted: number;
  };
  agent_today_qualified: { current: number; target: number };
  your_week_applied: { current: number; target: number };
  campaign_stop: boolean;
  as_of: string;
}

export interface JobStatusUpdate {
  job_id: number;
  from_status: JobStatus;
  status: JobStatus;
  updated_at: string;
  applied_at: string | null;
  campaign_stop: boolean;
  announcement: string;
}

export interface JobStatusObservation {
  expected_status: JobStatus;
  expected_updated_at: string;
}

export interface JobStatusEvent {
  from_status: string;
  to_status: string;
  changed_at: string;
  actor: string;
}

export interface JobHistoryResponse {
  events: JobStatusEvent[];
}

type UpdateJobStatus = (
  jobId: number,
  status: JobStatus,
  observation: JobStatusObservation,
) => Promise<JobStatusUpdate>;

interface StatusConflictError {
  status: number;
  body?: {
    current?: {
      id: number;
      status: string;
      updated_at: string;
      applied_at: string | null;
    };
  };
}

export async function commitJobStatus(
  role: JobRole,
  target: JobStatus,
  update: UpdateJobStatus,
  refreshSummary: () => Promise<JobsSummary>,
) {
  let result: JobStatusUpdate;
  try {
    result = await update(role.id, target, {
      expected_status: role.status as JobStatus,
      expected_updated_at: role.updated_at,
    });
  } catch (error) {
    const conflict = error as StatusConflictError;
    if (conflict.status !== 409 || !conflict.body?.current) throw error;
    return {
      role: { ...role, ...conflict.body.current },
      summary: null,
      summaryStale: null,
      conflict: true,
      announcement: "Status changed elsewhere. Review the current status before retrying.",
    };
  }
  const committedRole = {
    ...role,
    status: result.status,
    applied_at: result.applied_at,
    updated_at: result.updated_at,
  };
  try {
    return {
      role: committedRole,
      summary: await refreshSummary(),
      summaryStale: false,
      conflict: false,
      announcement: result.announcement,
    };
  } catch {
    return {
      role: committedRole,
      summary: null,
      summaryStale: true,
      conflict: false,
      announcement: `${result.announcement} Summary unavailable.`,
    };
  }
}

export function buildJobsQuery(filters: JobsFilters): string {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.lane) params.set("lane", filters.lane);
  if (filters.freshness) params.set("freshness", filters.freshness);
  if (filters.query.trim()) params.set("q", filters.query.trim());
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

function freshnessRank(freshness: JobFreshness): number {
  // Active first, then unknown, then stale (least urgent to act on now).
  if (freshness === "active") return 0;
  if (freshness === "unknown") return 1;
  return 2;
}

/**
 * The day's highest-value income actions: roles whose application packet is
 * built and just needs submitting. These are a single action away from
 * progress, so they lead the daily command surface — freshest and best-fit
 * first. Pure and deterministic so it can be unit-tested without the network.
 */
export function selectDailyActions(jobs: JobRole[], limit = 3): JobRole[] {
  return [...jobs]
    .filter((j) => j.status === "packet_ready_not_applied")
    .sort((a, b) => {
      const fr = freshnessRank(a.freshness) - freshnessRank(b.freshness);
      if (fr !== 0) return fr;
      if (b.fit_score !== a.fit_score) return b.fit_score - a.fit_score;
      return (b.date_found || "").localeCompare(a.date_found || "");
    })
    .slice(0, Math.max(0, limit));
}

export function statusLabel(status: string): string {
  if (status === "packet_ready_not_applied") return "Packet ready — not applied";
  return status
    .split("_")
    .map((part, index) =>
      index === 0 ? part.charAt(0).toUpperCase() + part.slice(1) : part,
    )
    .join(" ");
}

/**
 * Load the Jobs page in the order that matters.
 *
 * The pipeline list is what the owner came for; the summary is a readout above
 * it. The original implementation used `Promise.allSettled`, which makes two
 * requests independent in *outcome* but not in *time* — it resolves only once
 * both have settled, so a merely slow summary pinned the entire page on
 * "Loading jobs…". Round-2 on-machine recon measured that at over 90 seconds,
 * which turned an income-critical surface into a spinner.
 *
 * Here the two requests still start together, but the list is awaited on its
 * own and reported the instant it lands. The summary is claimed up front (so a
 * late rejection can never escape as an unhandled rejection) and reported
 * afterwards, arriving behind the content or degrading to the stale banner.
 */
export interface JobsLoadHandlers {
  onList(list: JobsListResponse): void;
  /** The pipeline is on screen; the page is usable from this point. */
  onReady(): void;
  /** `null` means the summary failed and the stale banner should show. */
  onSummary(summary: JobsSummary | null): void;
  onError(kind: "unconfigured" | "timeout" | "error"): void;
}

export async function loadJobs(
  listPromise: Promise<JobsListResponse>,
  summaryPromise: Promise<JobsSummary>,
  handlers: JobsLoadHandlers,
): Promise<void> {
  const settledSummary = summaryPromise.then(
    (value) => ({ ok: true as const, value }),
    () => ({ ok: false as const }),
  );

  let list: JobsListResponse;
  try {
    list = await listPromise;
  } catch (reason) {
    const text = String(reason);
    handlers.onError(
      /not configured|503/i.test(text)
        ? "unconfigured"
        : /timed out/i.test(text)
          ? "timeout"
          : "error",
    );
    return;
  }

  handlers.onList(list);
  handlers.onReady();

  const summary = await settledSummary;
  handlers.onSummary(summary.ok ? summary.value : null);
}
