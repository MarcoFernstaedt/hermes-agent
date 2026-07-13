import { describe, expect, it } from "vitest";

import { nextSlashSelection } from "@/lib/slash-selection";

describe("slash command keyboard selection", () => {
  it("moves and wraps in both directions", () => {
    expect(nextSlashSelection(0, 1, 4)).toBe(1);
    expect(nextSlashSelection(3, 1, 4)).toBe(0);
    expect(nextSlashSelection(0, -1, 4)).toBe(3);
  });

  it("stays safe when no commands are available", () => {
    expect(nextSlashSelection(2, 1, 0)).toBe(0);
  });
});
