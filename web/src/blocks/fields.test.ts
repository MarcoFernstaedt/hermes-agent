import { describe, expect, it } from "vitest";

import { formatField } from "./fields";

describe("fields.formatField", () => {
  it("renders empties as an em-dash", () => {
    expect(formatField("text", null)).toBe("—");
    expect(formatField("text", undefined)).toBe("—");
    expect(formatField("text", "")).toBe("—");
  });

  it("formats booleans", () => {
    expect(formatField("boolean", true)).toBe("Yes");
    expect(formatField("boolean", false)).toBe("No");
  });

  it("formats currency with a thousands separator", () => {
    expect(formatField("currency", 120000)).toBe("$120,000");
    expect(formatField("currency", "95000")).toBe("$95,000");
  });

  it("formats dates and passes through unparseable ones", () => {
    expect(formatField("date", "2026-07-22")).toMatch(/2026/);
    expect(formatField("date", "not-a-date")).toBe("not-a-date");
  });

  it("joins tag arrays", () => {
    expect(formatField("tags", ["a", "b"])).toBe("a, b");
  });

  it("stringifies plain text and numbers", () => {
    expect(formatField("text", "hi")).toBe("hi");
    expect(formatField("number", 42)).toBe("42");
  });
});
