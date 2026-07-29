import { describe, expect, it } from "vitest";

import {
  activeFilterCount,
  applyFilters,
  matchesFilters,
  type FilterField,
} from "./filter-model";

interface Row {
  status: string;
  lane: string;
}

const fields: FilterField<Row>[] = [
  {
    id: "status",
    label: "Status",
    accessor: (r) => r.status,
    options: [
      { value: "applied", label: "Applied" },
      { value: "offer", label: "Offer" },
    ],
  },
  {
    id: "lane",
    label: "Lane",
    accessor: (r) => r.lane,
    options: [{ value: "income", label: "Income" }],
  },
];

const rows: Row[] = [
  { status: "applied", lane: "income" },
  { status: "offer", lane: "growth" },
  { status: "applied", lane: "growth" },
];

describe("filter-model", () => {
  it("passes everything when nothing is selected", () => {
    expect(applyFilters(rows, fields, {})).toHaveLength(3);
  });

  it("filters by a single active field", () => {
    const out = applyFilters(rows, fields, { status: "applied" });
    expect(out).toHaveLength(2);
    expect(out.every((r) => r.status === "applied")).toBe(true);
  });

  it("ANDs multiple active filters", () => {
    const out = applyFilters(rows, fields, { status: "applied", lane: "income" });
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ status: "applied", lane: "income" });
  });

  it("treats null / empty as 'any'", () => {
    expect(matchesFilters(rows[0], fields, { status: null, lane: "" })).toBe(true);
  });

  it("counts active filters", () => {
    expect(activeFilterCount({ status: "applied", lane: null })).toBe(1);
    expect(activeFilterCount({ status: "applied", lane: "income" })).toBe(2);
    expect(activeFilterCount({})).toBe(0);
  });
});
