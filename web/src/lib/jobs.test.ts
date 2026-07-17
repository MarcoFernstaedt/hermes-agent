import { describe, expect, it } from "vitest";

import { buildJobsQuery, statusLabel } from "./jobs";

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
