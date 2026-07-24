/**
 * Shared field-schema types for the record blocks (FieldGrid now,
 * FormFromSchema later). A capability declares its entity fields once; both the
 * read surface (FieldGrid) and the edit surface (FormFromSchema) render from the
 * same list. Kept dependency-free and unit-testable.
 */
import type { ReactNode } from "react";

export type FieldType =
  | "text"
  | "number"
  | "currency"
  | "boolean"
  | "date"
  | "select"
  | "tags"
  | "markdown"
  | "url";

export interface FieldDef<T = Record<string, unknown>> {
  /** Key into the record + stable id. */
  name: string;
  /** Label shown in the grid / form. */
  label: string;
  type: FieldType;
  /** Options for a `select` field. */
  options?: Array<{ value: string; label: string }>;
  /** Optional custom value renderer for the read surface. */
  render?: (row: T) => ReactNode;
}

/** Format a raw field value for read display based on its declared type. */
export function formatField(type: FieldType, value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  switch (type) {
    case "boolean":
      return value ? "Yes" : "No";
    case "currency": {
      const n = typeof value === "number" ? value : Number(value);
      return Number.isFinite(n) ? `$${n.toLocaleString()}` : String(value);
    }
    case "date": {
      const t = Date.parse(String(value));
      if (Number.isNaN(t)) return String(value);
      return new Date(t).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
    }
    case "tags":
      return Array.isArray(value) ? value.join(", ") : String(value);
    case "select": {
      return String(value);
    }
    default:
      return String(value);
  }
}
