/**
 * Pure derivations from a Capability declaration — table columns, board
 * columns, legal transitions, record flattening. No React, so the mapping from
 * declaration to block inputs is unit-tested directly.
 */
import type { DataColumn } from "../blocks/data-table-model";
import type { BoardColumn } from "../blocks/board-model";
import { formatField, type FieldDef } from "../blocks/fields";
import type { Entity } from "../lib/api";
import type { Capability, CapabilityView, Lifecycle } from "./types";

/** A record flattened for the blocks: entity id + version alongside its data. */
export type FlatRecord = Record<string, unknown> & { id: string; __version: number };

/** Flatten a store entity into a row the blocks can render + write back. */
export function flatten(entity: Entity): FlatRecord {
  return { ...entity.data, id: entity.id, __version: entity.version };
}

/** Strip the synthetic id/version back off, leaving the store data payload. */
export function toData(record: FlatRecord): Record<string, unknown> {
  const { id: _id, __version: _v, ...data } = record;
  void _id;
  void _v;
  return data;
}

/** Look up a field definition by name. */
function fieldOf(cap: Capability, name: string): FieldDef | undefined {
  return cap.fields.find((f) => f.name === name);
}

/** Build DataTable columns for a table view (declared columns or all fields). */
export function tableColumns(cap: Capability, view: CapabilityView): DataColumn<FlatRecord>[] {
  const names = view.columns ?? cap.fields.map((f) => f.name);
  return names.map((name) => {
    const field = fieldOf(cap, name);
    const type = field?.type ?? "text";
    return {
      id: name,
      header: field?.label ?? name,
      accessor: (row) => {
        const v = row[name];
        return typeof v === "string" || typeof v === "number" || typeof v === "boolean"
          ? v
          : v == null
            ? null
            : String(v);
      },
      cell: (row) => formatField(type, row[name]),
      align: type === "number" || type === "currency" ? "right" : "left",
    };
  });
}

/**
 * Human labels for the lifecycle states, taken from the status field's declared
 * `select` options so the board headers read exactly like the edit form's
 * dropdown ("To do", not a label-cased "Todo"). States without a matching
 * option fall back to label-casing at render time.
 */
export function stateLabels(cap: Capability): Record<string, string> {
  const field = cap.lifecycle ? fieldOf(cap, cap.lifecycle.field) : undefined;
  const labels: Record<string, string> = {};
  for (const opt of field?.options ?? []) labels[opt.value] = opt.label;
  return labels;
}

/**
 * Board columns come from the lifecycle states. Labels prefer the status
 * field's option labels (see `stateLabels`); any state missing one is
 * label-cased so a column always has a readable header.
 */
export function boardColumns(
  lifecycle: Lifecycle,
  labels?: Record<string, string>,
): BoardColumn[] {
  return lifecycle.states.map((s) => ({ id: s, label: labels?.[s] ?? labelCase(s) }));
}

/** Legal target states from `from` per the lifecycle (honouring `"*"`). */
export function legalTransitions(lifecycle: Lifecycle, from: string): string[] {
  const out = new Set<string>();
  for (const t of lifecycle.transitions) {
    if (t.from === from || t.from === "*") for (const to of t.to) out.add(to);
  }
  return [...out];
}

/** Whether moving from → to is permitted by the lifecycle. */
export function canTransition(lifecycle: Lifecycle, from: string, to: string): boolean {
  return legalTransitions(lifecycle, from).includes(to);
}

/** Count records per lifecycle state (for the StatBar). */
export function countByState(
  records: readonly FlatRecord[],
  lifecycle: Lifecycle,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const s of lifecycle.states) counts[s] = 0;
  for (const r of records) {
    const s = String(r[lifecycle.field] ?? "");
    if (s in counts) counts[s] += 1;
  }
  return counts;
}

/** "packet_ready" → "Packet Ready". */
export function labelCase(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** The default view (declared default, else the first). */
export function defaultView(cap: Capability): CapabilityView {
  return cap.views.find((v) => v.default) ?? cap.views[0];
}
