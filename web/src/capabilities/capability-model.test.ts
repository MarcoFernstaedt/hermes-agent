import { describe, expect, it } from "vitest";

import {
  boardColumns,
  canTransition,
  countByState,
  defaultView,
  flatten,
  labelCase,
  legalTransitions,
  tableColumns,
} from "./capability-model";
import type { Capability, Lifecycle } from "./types";

const lifecycle: Lifecycle = {
  field: "status",
  states: ["saved", "applied", "offer", "archived"],
  initial: "saved",
  transitions: [
    { from: "saved", to: ["applied"] },
    { from: "applied", to: ["offer"] },
    { from: "*", to: ["archived"] },
  ],
};

const cap: Capability = {
  id: "job",
  label: "Jobs",
  titleField: "company",
  fields: [
    { name: "company", label: "Company", type: "text" },
    { name: "salary", label: "Salary", type: "currency" },
    { name: "status", label: "Status", type: "select" },
  ],
  lifecycle,
  views: [
    { id: "board", kind: "board", default: true },
    { id: "table", kind: "table", columns: ["company", "salary"] },
  ],
};

describe("capability-model", () => {
  it("flattens an entity into id + version + data", () => {
    const flat = flatten({
      id: "e1",
      type: "job",
      data: { company: "Acme" },
      version: 3,
      created_at: "",
      updated_at: "",
    });
    expect(flat).toEqual({ id: "e1", __version: 3, company: "Acme" });
  });

  it("builds table columns from the declared column list", () => {
    const cols = tableColumns(cap, cap.views[1]);
    expect(cols.map((c) => c.id)).toEqual(["company", "salary"]);
    expect(cols[1].align).toBe("right"); // currency
  });

  it("builds board columns from lifecycle states", () => {
    expect(boardColumns(lifecycle).map((c) => c.label)).toEqual([
      "Saved",
      "Applied",
      "Offer",
      "Archived",
    ]);
  });

  it("computes legal transitions honouring '*'", () => {
    expect(legalTransitions(lifecycle, "saved").sort()).toEqual(["applied", "archived"]);
    expect(canTransition(lifecycle, "saved", "applied")).toBe(true);
    expect(canTransition(lifecycle, "saved", "offer")).toBe(false);
    expect(canTransition(lifecycle, "offer", "archived")).toBe(true); // via '*'
  });

  it("counts records per state", () => {
    const counts = countByState(
      [
        { id: "1", __version: 1, status: "saved" },
        { id: "2", __version: 1, status: "saved" },
        { id: "3", __version: 1, status: "applied" },
      ],
      lifecycle,
    );
    expect(counts).toEqual({ saved: 2, applied: 1, offer: 0, archived: 0 });
  });

  it("label-cases identifiers and picks the default view", () => {
    expect(labelCase("packet_ready")).toBe("Packet Ready");
    expect(defaultView(cap).id).toBe("board");
  });
});
