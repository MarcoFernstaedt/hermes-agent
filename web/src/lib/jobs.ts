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

export function statusLabel(status: string): string {
  if (status === "packet_ready_not_applied") return "Packet ready — not applied";
  return status
    .split("_")
    .map((part, index) =>
      index === 0 ? part.charAt(0).toUpperCase() + part.slice(1) : part,
    )
    .join(" ");
}
