import { describe, expect, it } from "vitest";

import {
  buildJobsQuery,
  loadJobs,
  selectDailyActions,
  statusLabel,
  type JobRole,
  type JobsListResponse,
  type JobsSummary,
} from "./jobs";

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

describe("loadJobs", () => {
  const list = {
    items: [],
    filters: { statuses: [], lanes: [] },
  } as unknown as JobsListResponse;
  const summary = { counts: {} } as unknown as JobsSummary;

  function recorder() {
    const events: string[] = [];
    return {
      events,
      handlers: {
        onList: () => events.push("list"),
        onReady: () => events.push("ready"),
        onSummary: (s: JobsSummary | null) => events.push(s ? "summary" : "stale"),
        onError: (k: string) => events.push(`error:${k}`),
      },
    };
  }

  it("renders the pipeline before the summary settles", async () => {
    // The defect: `Promise.allSettled` held the page on "Loading jobs…" until
    // *both* requests finished, so a slow summary blocked the content. Ready
    // must precede the summary, not wait on it.
    let releaseSummary: (s: JobsSummary) => void = () => {};
    const slowSummary = new Promise<JobsSummary>((resolve) => {
      releaseSummary = resolve;
    });
    const r = recorder();

    const done = loadJobs(Promise.resolve(list), slowSummary, r.handlers);
    // Let the list promise flush without resolving the summary at all.
    await Promise.resolve();
    await Promise.resolve();
    expect(r.events).toEqual(["list", "ready"]);

    releaseSummary(summary);
    await done;
    expect(r.events).toEqual(["list", "ready", "summary"]);
  });

  it("degrades a failed summary to stale without hiding the pipeline", async () => {
    const r = recorder();
    await loadJobs(Promise.resolve(list), Promise.reject(new Error("500")), r.handlers);
    expect(r.events).toEqual(["list", "ready", "stale"]);
  });

  it("distinguishes a timeout from a generic failure", async () => {
    const r = recorder();
    await loadJobs(
      Promise.reject(new Error("Request timed out after 15000ms: /api/jobs")),
      Promise.resolve(summary),
      r.handlers,
    );
    expect(r.events).toEqual(["error:timeout"]);
  });

  it("reports an unconfigured tracker distinctly", async () => {
    const r = recorder();
    await loadJobs(
      Promise.reject(new Error("jobs not configured")),
      Promise.resolve(summary),
      r.handlers,
    );
    expect(r.events).toEqual(["error:unconfigured"]);
  });

  it("never leaks an unhandled rejection when the summary fails after an error", async () => {
    const r = recorder();
    const failingSummary = Promise.reject(new Error("boom"));
    await loadJobs(Promise.reject(new Error("nope")), failingSummary, r.handlers);
    // Give the microtask queue a chance to surface an unhandled rejection.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(r.events).toEqual(["error:error"]);
  });
});
