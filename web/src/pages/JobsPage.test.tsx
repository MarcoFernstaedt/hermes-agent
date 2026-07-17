import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { JobRole, JobsSummary } from "@/lib/jobs";
import { JobsView } from "./JobsPage";

const summary: JobsSummary = {
  counts: {
    qualified_packet_ready: 75,
    applied: 2,
    pending: 3,
    interviewing: 4,
    rejected: 5,
    expired: 6,
    offer_received: 1,
    offer_accepted: 0,
  },
  today_prepared: { current: 50, target: 300 },
  week_applied: { current: 2, target: 1500 },
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

    expect(loading).toContain('<main aria-labelledby="jobs-heading"');
    expect(loading).toContain("Loading jobs…");
    expect(error).toContain('role="alert"');
    expect(error).toContain(">Retry<");
    expect(empty).toContain("No roles found.");
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
      "Packet ready",
      "Applied",
      "Pending response",
      "Interviewing",
      "Rejected",
      "Expired / closed",
      "Offers",
      "Accepted offer",
      "Today prepared",
      "Week applied",
    ]) expect(html).toContain(text);
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
});
