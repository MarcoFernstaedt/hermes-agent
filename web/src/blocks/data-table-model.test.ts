import { describe, expect, it } from "vitest";

import {
  compareValues,
  cycleSort,
  headerCheckboxState,
  renderValue,
  toggleAll,
  toggleRow,
} from "./data-table-model";

describe("data-table-model", () => {
  it("cycles sort unsorted → asc → desc → unsorted", () => {
    expect(cycleSort(undefined)).toBe("asc");
    expect(cycleSort("asc")).toBe("desc");
    expect(cycleSort("desc")).toBeUndefined();
  });

  it("toggles a single row without mutating the input", () => {
    const start = new Set(["a"]);
    const added = toggleRow(start, "b");
    expect([...added].sort()).toEqual(["a", "b"]);
    expect([...start]).toEqual(["a"]); // unmutated
    expect([...toggleRow(added, "a")]).toEqual(["b"]);
  });

  it("select-all toggles between all and none", () => {
    const ids = ["a", "b", "c"];
    const all = toggleAll(new Set(), ids);
    expect([...all].sort()).toEqual(["a", "b", "c"]);
    // Already all selected → clears.
    expect(toggleAll(all, ids).size).toBe(0);
    // Partial → selects all.
    expect(toggleAll(new Set(["a"]), ids).size).toBe(3);
  });

  it("reports the tri-state header checkbox", () => {
    const ids = ["a", "b", "c"];
    expect(headerCheckboxState(new Set(), ids)).toBe("none");
    expect(headerCheckboxState(new Set(["a"]), ids)).toBe("some");
    expect(headerCheckboxState(new Set(ids), ids)).toBe("all");
    expect(headerCheckboxState(new Set(), [])).toBe("none");
  });

  it("compares values with numbers numeric and empties last", () => {
    expect(compareValues(2, 10)).toBeLessThan(0);
    expect(compareValues("b", "a")).toBeGreaterThan(0);
    expect(compareValues(null, 5)).toBeGreaterThan(0); // null sorts last
    expect(compareValues(5, null)).toBeLessThan(0);
    expect(compareValues(null, undefined)).toBe(0);
    // Natural numeric ordering inside strings.
    expect(compareValues("item2", "item10")).toBeLessThan(0);
  });

  it("renders values as display text", () => {
    expect(renderValue(null)).toBe("");
    expect(renderValue(undefined)).toBe("");
    expect(renderValue(true)).toBe("Yes");
    expect(renderValue(false)).toBe("No");
    expect(renderValue(42)).toBe("42");
    expect(renderValue("hi")).toBe("hi");
  });
});
