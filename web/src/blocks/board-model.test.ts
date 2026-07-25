import { describe, expect, it } from "vitest";

import { groupItems, isOverLimit, isRealMove, type BoardColumn } from "./board-model";

interface Card {
  id: string;
  status: string;
}

const columns: BoardColumn[] = [
  { id: "saved", label: "Saved" },
  { id: "applied", label: "Applied", wipLimit: 2 },
  { id: "offer", label: "Offer" },
];

describe("board-model", () => {
  it("groups items by column preserving order", () => {
    const items: Card[] = [
      { id: "a", status: "saved" },
      { id: "b", status: "applied" },
      { id: "c", status: "saved" },
    ];
    const groups = groupItems(items, columns, (c) => c.status);
    expect(groups.get("saved")!.map((c) => c.id)).toEqual(["a", "c"]);
    expect(groups.get("applied")!.map((c) => c.id)).toEqual(["b"]);
    expect(groups.get("offer")!).toEqual([]);
  });

  it("drops items whose column is not shown", () => {
    const items: Card[] = [{ id: "x", status: "archived" }];
    const groups = groupItems(items, columns, (c) => c.status);
    const total = [...groups.values()].reduce((n, arr) => n + arr.length, 0);
    expect(total).toBe(0);
  });

  it("flags WIP-limit breaches", () => {
    expect(isOverLimit(3, 2)).toBe(true);
    expect(isOverLimit(2, 2)).toBe(false);
    expect(isOverLimit(99, undefined)).toBe(false);
  });

  it("detects a real (cross-column) move", () => {
    expect(isRealMove("saved", "applied")).toBe(true);
    expect(isRealMove("saved", "saved")).toBe(false);
  });
});
