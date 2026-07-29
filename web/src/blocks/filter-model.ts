/**
 * Pure model for the FilterBar block: a declarative set of filter fields and a
 * predicate that applies the current selection to an item. No React, so the
 * matching logic is unit-tested directly.
 */

export interface FilterField<T = unknown> {
  /** Stable id + key into the selection state. */
  id: string;
  label: string;
  options: Array<{ value: string; label: string }>;
  /** Value getter for the item this filter compares against. */
  accessor: (item: T) => string | number | null | undefined;
}

/** The current selection: field id → chosen option value (or null = any). */
export type FilterState = Record<string, string | null>;

/** True when an item satisfies every active (non-null) filter. */
export function matchesFilters<T>(
  item: T,
  fields: readonly FilterField<T>[],
  state: FilterState,
): boolean {
  for (const field of fields) {
    const selected = state[field.id];
    if (selected == null || selected === "") continue; // "any"
    if (String(field.accessor(item)) !== selected) return false;
  }
  return true;
}

/** Apply the filters to a list. */
export function applyFilters<T>(
  items: readonly T[],
  fields: readonly FilterField<T>[],
  state: FilterState,
): T[] {
  return items.filter((item) => matchesFilters(item, fields, state));
}

/** How many filters are currently active (for a "clear (N)" affordance). */
export function activeFilterCount(state: FilterState): number {
  return Object.values(state).filter((v) => v != null && v !== "").length;
}
