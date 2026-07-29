import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { auditA11y } from "@/lib/a11y-audit";
import type { HubContext } from "@/lib/api";
import { NowView } from "./NowPage";

function context(over: Partial<HubContext["sections"]> = {}, attention: string[] = ["Nothing is waiting."]): HubContext {
  return {
    generated_at: "2026-07-29T05:00:00+00:00",
    generated_at_epoch: 1785301200,
    attention,
    sections: {
      guardrails: { available: true, halted: false, scope: null, note: "Tools are available." },
      review: { available: true, counts: { pending: 0 }, pending: [] },
      jobs: { available: true, counts: {}, next_actions: [] },
      capabilities: { available: true, areas: [], due_or_overdue: [] },
      health: { available: true, status: "ok", problems: [] },
      ...over,
    },
  };
}

function render(data: HubContext | null, error = false) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <NowView data={data} error={error} refreshing={false} onRefresh={() => {}} />
    </MemoryRouter>,
  );
}

describe("NowView", () => {
  it("leads with the attention lines", () => {
    const html = render(context({}, ["3 proposals waiting on your approval.", "1 tracked item due."]));
    expect(html).toContain("3 proposals waiting on your approval.");
    // The first line carries the emphasis; the rest are quiet.
    expect(html.indexOf("3 proposals")).toBeLessThan(html.indexOf("1 tracked item"));
  });

  it("shows the halt panel only when the agent is actually halted", () => {
    const quiet = render(context());
    expect(quiet).not.toContain("The agent is halted");

    const halted = render(
      context({
        guardrails: { available: true, halted: true, scope: null, note: "All tool activity is halted." },
      }),
    );
    expect(halted).toContain("The agent is halted");
    expect(halted).toContain("All tool activity is halted.");
  });

  it("lists pending approvals with their risk", () => {
    const html = render(
      context({
        review: {
          available: true,
          counts: { pending: 1 },
          pending: [
            { id: "p1", kind: "capability", title: "Add a Recipes area", risk: "high", source: "agent" },
          ],
        },
      }),
    );
    expect(html).toContain("Add a Recipes area");
    expect(html).toContain("high risk");
  });

  it("names an unavailable section instead of pretending it is empty", () => {
    // "No jobs shown because the vault is unconfigured" is a different fact
    // from "nothing to apply to". Conflating them is a lie of omission.
    const html = render(
      context({ jobs: { available: false, reason: "jobs vault is not configured", next_actions: [] } }),
    );
    expect(html).toContain("Not included: jobs (jobs vault is not configured)");
    expect(html).not.toContain("Ready to send");
  });

  it("confirms when every source reported in", () => {
    expect(render(context())).toContain("Every source reported in.");
  });

  it("renders an accessible loading state", () => {
    expect(render(null)).toContain("Reading the current state…");
  });

  it("surfaces a failed fetch as an alert rather than an empty page", () => {
    const html = render(null, true);
    expect(html).toContain('role="alert"');
    expect(html).toContain("Context unavailable");
  });

  it("passes the accessibility audit in its busiest state", () => {
    const html = render(
      context(
        {
          guardrails: { available: true, halted: true, scope: null, note: "Halted." },
          review: {
            available: true,
            counts: { pending: 1 },
            pending: [{ id: "p1", kind: "skill", title: "Install x", risk: "medium", source: "agent" }],
          },
          jobs: {
            available: true,
            counts: { packet_ready: 2 },
            next_actions: [{ id: 1, company: "Acme", role: "Support Engineer", fit_score: 92 }],
          },
          capabilities: {
            available: true,
            areas: [],
            due_or_overdue: [{ capability: "tasks", title: "File taxes", field: "due", date: "2026-01-01" }],
          },
          health: { available: true, status: "warn", problems: ["build: warn"] },
        },
        ["The global stop is engaged."],
      ),
    );
    expect(auditA11y(html)).toEqual([]);
  });
});
