/**
 * Pure model + helpers for the DataTable block. No React here, so the sort,
 * selection and formatting logic is unit-tested directly; the component
 * (DataTable.tsx) is a thin rendering layer over TanStack Table that leans on
 * these for the app-facing contract.
 */
import type { ReactNode } from "react";

export type SortDirection = "asc" | "desc";

/** A column declaration in app terms (not TanStack's internal shape). */
export interface DataColumn<T> {
  /** Stable id; also the key used in sort/visibility state. */
  id: string;
  /** Header label. */
  header: string;
  /** Value getter — used for sorting and the default cell render. */
  accessor: (row: T) => string | number | boolean | null | undefined;
  /** Optional custom cell renderer (overrides the default text render). */
  cell?: (row: T) => ReactNode;
  /** Whether the column can be sorted (default true). */
  sortable?: boolean;
  /** Whether cells can be inline-edited (default false). */
  editable?: boolean;
  /** Fixed / initial width in px. */
  width?: number;
  /** Text alignment. */
  align?: "left" | "right" | "center";
}

/**
 * Cycle a header's sort state on click: unsorted → asc → desc → unsorted.
 * Kept pure so the three-state toggle is trivially testable.
 */
export function cycleSort(current: SortDirection | undefined): SortDirection | undefined {
  if (current === undefined) return "asc";
  if (current === "asc") return "desc";
  return undefined;
}

/** Toggle one row id in a selection set, returning a new set. */
export function toggleRow(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/**
 * Select-all / clear-all: if every id is already selected, clear them;
 * otherwise select all. Returns a new set.
 */
export function toggleAll(
  selected: ReadonlySet<string>,
  allIds: readonly string[],
): Set<string> {
  const allSelected = allIds.length > 0 && allIds.every((id) => selected.has(id));
  return allSelected ? new Set() : new Set(allIds);
}

/** Tri-state header checkbox: all / none / some (indeterminate). */
export function headerCheckboxState(
  selected: ReadonlySet<string>,
  allIds: readonly string[],
): "all" | "none" | "some" {
  if (allIds.length === 0) return "none";
  let count = 0;
  for (const id of allIds) if (selected.has(id)) count += 1;
  if (count === 0) return "none";
  if (count === allIds.length) return "all";
  return "some";
}

/** Compare two accessor values for sorting (numbers numerically, else by
 *  locale-aware string; null/undefined sort last). */
export function compareValues(
  a: string | number | boolean | null | undefined,
  b: string | number | boolean | null | undefined,
): number {
  const aEmpty = a === null || a === undefined;
  const bEmpty = b === null || b === undefined;
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

/** Default text rendering for a cell value. */
export function renderValue(
  value: string | number | boolean | null | undefined,
): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}
