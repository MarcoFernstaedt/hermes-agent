/**
 * The Capability declaration — a document that describes a working area
 * (entity, fields, lifecycle, views) which the renderer turns into a full,
 * live surface (board + table + form + record detail) over the generic entity
 * store, with no bespoke code. See docs/plans/intelligence-hub-architecture.md
 * (Phase C).
 */
import type { ComponentType } from "react";

import type { FieldDef } from "@/blocks";
import type { ModuleGroup } from "@/modules/types";

/** A lifecycle: which field holds the status, the ordered states, and the
 *  legal transitions between them. `"*"` as a `from` allows any source. */
export interface Lifecycle {
  field: string;
  states: string[];
  initial: string;
  transitions: Array<{ from: string; to: string[] }>;
}

export interface CapabilityView {
  id: string;
  kind: "board" | "table";
  /** Board: field to group columns by (defaults to the lifecycle field). */
  groupBy?: string;
  /** Table: ordered field names to show as columns (defaults to all fields). */
  columns?: string[];
  /** The view shown first. */
  default?: boolean;
}

export interface Capability {
  /** Stable id — also the route segment (/c/<id>) and entity type. */
  id: string;
  label: string;
  icon?: ComponentType<{ className?: string }>;
  group?: ModuleGroup;
  /** Entity type key in the store (defaults to id). */
  entity?: string;
  /** Field whose value titles a record. */
  titleField: string;
  /** Optional subtitle field for record headers / cards. */
  subtitleField?: string;
  fields: FieldDef[];
  lifecycle?: Lifecycle;
  views: CapabilityView[];
}

/** The store entity type a capability's records live under. */
export function entityTypeOf(cap: Capability): string {
  return cap.entity ?? cap.id;
}
