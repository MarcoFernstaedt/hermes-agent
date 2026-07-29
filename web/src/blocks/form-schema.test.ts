import { describe, expect, it } from "vitest";

import { buildDefaults, buildZodSchema, defaultForField } from "./form-schema";
import type { FieldDef } from "./fields";

const fields: FieldDef[] = [
  { name: "title", label: "Title", type: "text", required: true },
  { name: "salary", label: "Salary", type: "currency" },
  { name: "site", label: "Site", type: "url" },
  { name: "remote", label: "Remote", type: "boolean" },
  { name: "tags", label: "Tags", type: "tags" },
];

describe("form-schema", () => {
  it("requires a non-empty required text field", () => {
    const schema = buildZodSchema(fields);
    expect(schema.safeParse({ title: "", remote: false }).success).toBe(false);
    const ok = schema.safeParse({ title: "Engineer", remote: false });
    expect(ok.success).toBe(true);
  });

  it("coerces number/currency and allows blank when optional", () => {
    const schema = buildZodSchema(fields);
    const r = schema.safeParse({ title: "x", salary: "120000", remote: false });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.salary).toBe(120000);
    // Blank optional number is allowed.
    expect(schema.safeParse({ title: "x", salary: "", remote: false }).success).toBe(true);
  });

  it("validates url shape but allows blank when optional", () => {
    const schema = buildZodSchema(fields);
    expect(schema.safeParse({ title: "x", site: "not a url", remote: false }).success).toBe(false);
    expect(schema.safeParse({ title: "x", site: "https://x.com", remote: false }).success).toBe(true);
    expect(schema.safeParse({ title: "x", site: "", remote: false }).success).toBe(true);
  });

  it("splits a comma-separated tags string into an array", () => {
    const schema = buildZodSchema(fields);
    const r = schema.safeParse({ title: "x", remote: false, tags: "a, b ,c" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.tags).toEqual(["a", "b", "c"]);
  });

  it("derives type-appropriate defaults", () => {
    expect(defaultForField("boolean")).toBe(false);
    expect(defaultForField("text")).toBe("");
    expect(defaultForField("tags")).toBe("");
  });

  it("builds defaults from a record, joining tag arrays", () => {
    const d = buildDefaults(fields, {
      title: "Engineer",
      salary: 90000,
      remote: true,
      tags: ["x", "y"],
    });
    expect(d.title).toBe("Engineer");
    expect(d.remote).toBe(true);
    expect(d.tags).toBe("x, y");
    expect(d.site).toBe(""); // missing → empty
  });
});
