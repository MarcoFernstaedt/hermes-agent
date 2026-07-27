import { describe, expect, it } from "vitest";

import { buildJobsQuery, selectDailyActions, statusLabel, type JobRole } from "./jobs";

function role(over: Partial<JobRole>): JobRole {
  return {
    id: 0,
    company: "Co",
    role_title: "Role",
    lane: "lane",
    location: "Remote",
    work_mode: "Remote",
    pay: null,
    source_url: null,
    apply_url: null,
    requisition_id: null,
    date_found: "2026-07-01",
    fit_score: 50,
    verdict: "apply",
    fit_rationale: "",
    gaps: [],
    blockers: [],
    recommended_action: "",
    status: "packet_ready_not_applied",
    updated_at: "2026-07-01T00:00:00Z",
    applied_at: null,
    checked_at: null,
    freshness: "active",
    assets: [],
    ...over,
  };
}

describe("selectDailyActions", () => {
  it("only surfaces packet-ready-not-applied roles", () => {
    const jobs = [
      role({ id: 1, status: "applied" }),
      role({ id: 2, status: "packet_ready_not_applied" }),
      role({ id: 3, status: "interviewing" }),
    ];
    expect(selectDailyActions(jobs).map((j) => j.id)).toEqual([2]);
  });

  it("ranks active freshness above stale, then by fit score", () => {
    const jobs = [
      role({ id: 1, freshness: "stale", fit_score: 99 }),
      role({ id: 2, freshness: "active", fit_score: 70 }),
      role({ id: 3, freshness: "active", fit_score: 90 }),
    ];
    expect(selectDailyActions(jobs).map((j) => j.id)).toEqual([3, 2, 1]);
  });

  it("caps the list at the requested limit without mutating input", () => {
    const jobs = Array.from({ length: 8 }, (_, i) =>
      role({ id: i + 1, fit_score: 100 - i }),
    );
    const before = jobs.map((j) => j.id);
    expect(selectDailyActions(jobs, 3).map((j) => j.id)).toEqual([1, 2, 3]);
    expect(jobs.map((j) => j.id)).toEqual(before);
  });

  it("returns nothing when there is no ready work", () => {
    expect(selectDailyActions([role({ status: "applied" })])).toEqual([]);
  });
});

describe("jobs filters", () => {
  it("encodes only selected filters and search", () => {
    expect(
      buildJobsQuery({
        status: "packet_ready_not_applied",
        lane: "quality assurance",
        freshness: "active",
        query: "support & qa",
      }),
    ).toBe(
      "?status=packet_ready_not_applied&lane=quality+assurance&freshness=active&q=support+%26+qa",
    );
    expect(buildJobsQuery({ status: "", lane: "", freshness: "", query: "" })).toBe("");
  });

  it("uses concise readable status labels", () => {
    expect(statusLabel("packet_ready_not_applied")).toBe("Packet ready — not applied");
    expect(statusLabel("offer_accepted")).toBe("Offer accepted");
  });
});
