import { describe, expect, it } from "vitest";

import { layoutGraph, neighborsOf } from "./graph-layout";

describe("graph-layout", () => {
  it("puts each entity type in its own column", () => {
    const laid = layoutGraph(
      [
        { id: "a", type: "reading", label: "A" },
        { id: "b", type: "task", label: "B" },
        { id: "c", type: "reading", label: "C" },
      ],
      { width: 1000, height: 600 },
    );
    const reading = laid.filter((n) => n.type === "reading");
    const task = laid.filter((n) => n.type === "task");
    // Same type shares an x (a column); different types differ.
    expect(reading[0].x).toBe(reading[1].x);
    expect(reading[0].x).not.toBe(task[0].x);
    // Two reading nodes get distinct y positions.
    expect(reading[0].y).not.toBe(reading[1].y);
  });

  it("centers a single node", () => {
    const [only] = layoutGraph([{ id: "a", type: "t", label: "A" }], {
      width: 1000,
      height: 600,
    });
    expect(only.x).toBe(500);
    expect(only.y).toBe(300);
  });

  it("neighborsOf collects both edge directions", () => {
    const edges = [
      { source: "a", target: "b" },
      { source: "c", target: "a" },
      { source: "b", target: "c" },
    ];
    expect([...neighborsOf("a", edges)].sort()).toEqual(["b", "c"]);
    expect([...neighborsOf("b", edges)].sort()).toEqual(["a", "c"]);
    expect([...neighborsOf("z", edges)]).toEqual([]);
  });
});
