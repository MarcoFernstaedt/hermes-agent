/**
 * Pure Zod-schema construction from a FieldDef[] — the bridge between a
 * capability's declared fields and a validated edit form. Kept separate from
 * the React component so the type→validator mapping and default-value derivation
 * are unit-testable without rendering.
 */
import { z } from "zod";

import type { FieldDef, FieldType } from "./fields";

/** Build a Zod object schema validating one field by its declared type. */
function zodForField(type: FieldType, required: boolean): z.ZodTypeAny {
  switch (type) {
    case "number":
    case "currency": {
      // Empty string → undefined so a non-required number can be blank.
      const base = z.preprocess(
        (v) => (v === "" || v === null || v === undefined ? undefined : Number(v)),
        z.number({ invalid_type_error: "Must be a number" }).optional(),
      );
      return required
        ? base.refine((v) => v !== undefined, { message: "Required" })
        : base;
    }
    case "boolean":
      return z.boolean().default(false);
    case "url": {
      const base = z.string().url("Must be a valid URL");
      return required ? base : base.or(z.literal("")).optional();
    }
    case "tags":
      // Comma-separated input → trimmed, de-empty array.
      return z.preprocess(
        (v) =>
          typeof v === "string"
            ? v.split(",").map((s) => s.trim()).filter(Boolean)
            : Array.isArray(v)
              ? v
              : [],
        required
          ? z.array(z.string()).min(1, "Required")
          : z.array(z.string()),
      );
    default: {
      // text, date, select, markdown → string
      const base = z.string();
      return required ? base.min(1, "Required") : base.optional().or(z.literal(""));
    }
  }
}

export function buildZodSchema(
  fields: FieldDef[],
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const f of fields) {
    shape[f.name] = zodForField(f.type, Boolean(f.required));
  }
  return z.object(shape);
}

/** Sensible empty default per field type for a create form. */
export function defaultForField(type: FieldType): unknown {
  switch (type) {
    case "boolean":
      return false;
    case "tags":
      return "";
    default:
      return "";
  }
}

/** Build the initial form values: the record's value where present, else a
 *  type-appropriate empty. Tags arrays are joined for the comma-separated input. */
export function buildDefaults(
  fields: FieldDef[],
  record?: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const raw = record?.[f.name];
    if (raw === undefined || raw === null) {
      out[f.name] = defaultForField(f.type);
    } else if (f.type === "tags") {
      out[f.name] = Array.isArray(raw) ? raw.join(", ") : String(raw);
    } else if (f.type === "boolean") {
      out[f.name] = Boolean(raw);
    } else {
      out[f.name] = raw;
    }
  }
  return out;
}
