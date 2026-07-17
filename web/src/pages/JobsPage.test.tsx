import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { commitJobStatus, type JobRole, type JobsSummary } from "@/lib/jobs";
import { JobsView } from "./JobsPage";

const summary: JobsSummary = {
  counts: {
    total: 99,
    packet_ready: 75,
    applied: 2,
    pending: 3,
    interviewing: 4,
    rejected: 5,
    expired: 6,
    offer_received: 1,
    offer_accepted: 0,
  },
  agent_today_qualified: { current: 50, target: 300 },
  your_week_applied: { current: 2, target: 1500 },
  campaign_stop: false,
  as_of: "2026-07-17T12:00:00Z",
};

const role: JobRole = {
  id: 1,
  company: "Example Co",
  role_title: "Support Engineer",
  lane: "technical_support",
  location: "Remote",
  work_mode: "Remote",
  pay: "$25/hour",
  source_url: "https://source.example/1",
  apply_url: "https://apply.example/1",
  requisition_id: "REQ-1",
  date_found: "2026-07-17",
  fit_score: 92,
  verdict: "apply",
  fit_rationale: "Strong support fit.",
  gaps: ["One minor gap"],
  blockers: [],
  recommended_action: "Review packet",
  status: "packet_ready_not_applied",
  updated_at: "2026-07-17T12:00:00Z",
  applied_at: null,
  checked_at: "2026-07-17T11:00:00Z",
  freshness: "active",
  assets: [
    {
      id: 1,
      type: "application_packet",
      name: "Application Packet.md",
      media_type: "text/markdown",
      open_url: "/api/jobs/1/assets/1?disposition=inline",
      download_url: "/api/jobs/1/assets/1?disposition=attachment",
    },
  ],
};

const handlers = {
  onFiltersChange: vi.fn(),
  onRetry: vi.fn(),
  onStatusSelect: vi.fn(),
  onStatusUpdate: vi.fn(),
  onAsset: vi.fn(),
};

describe("JobsView", () => {
  it("keeps a committed status when the summary refresh fails", async () => {
    const update = vi.fn().mockResolvedValue({
      job_id: 1,
      from_status: "packet_ready_not_applied",
      status: "applied",
      updated_at: "2026-07-17T13:00:00Z",
      applied_at: "2026-07-17T13:00:00Z",
      campaign_stop: false,
      announcement: "Status updated to Applied.",
    });
    const refreshSummary = vi.fn().mockRejectedValue(new Error("unavailable"));

    const result = await commitJobStatus(
      role,
      "applied",
      update,
      refreshSummary,
    );

    expect(update).toHaveBeenCalledWith(1, "applied", {
      expected_status: "packet_ready_not_applied",
      expected_updated_at: "2026-07-17T12:00:00Z",
    });
    expect(result.role.status).toBe("applied");
    expect(result.summary).toBeNull();
    expect(result.summaryStale).toBe(true);
    expect(result.announcement).toContain("Status updated to Applied.");
    expect(result.announcement).not.toContain("not updated");
  });

  it("reconciles a 409 conflict and requires a deliberate retry", async () => {
    const conflict = Object.assign(new Error("409: conflict"), {
      status: 409,
      body: {
        detail: "Job status changed",
        current: {
          id: 1,
          status: "applied",
          updated_at: "2026-07-17T13:00:00Z",
          applied_at: "2026-07-17T13:00:00Z",
        },
      },
    });
    const update = vi.fn().mockRejectedValue(conflict);
    const refreshSummary = vi.fn();

    const result = await commitJobStatus(
      role,
      "withdrawn",
      update,
      refreshSummary,
    );

    expect(result.role.status).toBe("applied");
    expect(result.role.updated_at).toBe("2026-07-17T13:00:00Z");
    expect(result.conflict).toBe(true);
    expect(result.announcement).toContain("changed elsewhere");
    expect(refreshSummary).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("renders accessible loading, error, and empty states", () => {
    const loading = renderToStaticMarkup(
      <JobsView state="loading" summary={null} roles={[]} filters={{ status: "", lane: "", freshness: "", query: "" }} {...handlers} />,
    );
    const error = renderToStaticMarkup(
      <JobsView state="error" error="Jobs could not load." summary={null} roles={[]} filters={{ status: "", lane: "", freshness: "", query: "" }} {...handlers} />,
    );
    const empty = renderToStaticMarkup(
      <JobsView state="ready" summary={summary} roles={[]} filters={{ status: "", lane: "", freshness: "", query: "" }} {...handlers} />,
    );

    expect(loading).toContain('<section aria-labelledby="jobs-heading"');
    expect(loading).toContain("Loading jobs…");
    expect(error).toContain('role="alert"');
    expect(error).toContain(">Retry<");
    expect(empty).toContain("No roles found.");
  });

  it("renders a setup guide when the jobs vault is not configured", () => {
    const html = renderToStaticMarkup(
      <JobsView state="unconfigured" summary={null} roles={[]} filters={{ status: "", lane: "", freshness: "", query: "" }} {...handlers} />,
    );
    expect(html).toContain("isn&#x27;t configured yet");
    expect(html).toContain("HERMES_JOBS_DB_PATH");
    expect(html).toContain("HERMES_JOBS_PACKET_ROOT");
    expect(html).toContain("Check again");
  });

  it("renders distinct summary progress and complete card controls", () => {
    const html = renderToStaticMarkup(
      <JobsView
        state="ready"
        summary={summary}
        roles={[role]}
        filters={{ status: "", lane: "", freshness: "", query: "" }}
        {...handlers}
      />,
    );

    for (const text of [
      "Total jobs",
      "Packet ready — not applied",
      "Applied",
      "Pending response",
      "Interviewing",
      "Rejected",
      "Expired / closed",
      "Offers",
      "Accepted offer",
      "Agent today qualified",
      "Your week applied",
    ]) expect(html).toContain(text);
    expect(html).toMatch(
      /<h3[^>]*>Packet ready — not applied<\/h3>/,
    );
    expect(html).not.toContain("Today prepared");
    expect(html).not.toContain("Week applied");
    expect(html).toContain("Example Co");
    expect(html).toContain("Support Engineer");
    expect(html).toContain("$25/hour");
    expect(html).toContain("Fit 92");
    expect(html).toContain("Active");
    expect(html).toContain("Open apply page");
    expect(html).toContain("Open source");
    expect(html).toContain("Open Application Packet.md");
    expect(html).toContain("Download Application Packet.md");
    expect(html).toContain('aria-label="Status for Support Engineer at Example Co"');
    expect(html).toContain('aria-label="Update status for Support Engineer at Example Co"');
    expect(html).toContain("min-h-11");
    expect(html).not.toContain("Submit application");
  });

  it("announces accepted-offer stop state without execution controls", () => {
    const accepted = { ...summary, campaign_stop: true, counts: { ...summary.counts, offer_accepted: 1 } };
    const html = renderToStaticMarkup(
      <JobsView state="ready" summary={accepted} roles={[{ ...role, status: "offer_accepted" }]} filters={{ status: "", lane: "", freshness: "", query: "" }} announcement="Status updated to Offer accepted." {...handlers} />,
    );

    expect(html).toContain("Offer accepted. Campaign stop signal is active.");
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain("Stop campaign now");
  });

  it("renders source pipeline statuses as read-only tracking facts", () => {
    const html = renderToStaticMarkup(
      <JobsView
        state="ready"
        summary={summary}
        roles={[{ ...role, status: "ineligible" } as JobRole]}
        filters={{ status: "", lane: "", freshness: "", query: "" }}
        {...handlers}
      />,
    );

    expect(html).toContain("Ineligible");
    expect(html).toMatch(
      /aria-label="Status for Support Engineer at Example Co"[^>]*disabled=""/,
    );
  });
});
