/**
 * Pure model for the BoardView (kanban) block. Grouping items into columns and
 * WIP-limit checks live here, dependency-free and unit-tested; the component is
 * a drag-and-drop rendering layer over this.
 */

export interface BoardColumn {
  /** Stable id; matched against each item's column id. */
  id: string;
  label: string;
  /** Optional work-in-progress limit; the column flags when exceeded. */
  wipLimit?: number;
}

/**
 * Group items into their columns, preserving both column order (from
 * `columns`) and item order (from `items`). Items whose column id matches no
 * declared column are dropped (they belong to a stage the board doesn't show).
 */
export function groupItems<T>(
  items: readonly T[],
  columns: readonly BoardColumn[],
  getColumnId: (item: T) => string,
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const col of columns) groups.set(col.id, []);
  for (const item of items) {
    const colId = getColumnId(item);
    const bucket = groups.get(colId);
    if (bucket) bucket.push(item);
  }
  return groups;
}

/** True when a column's item count exceeds its WIP limit. */
export function isOverLimit(count: number, wipLimit?: number): boolean {
  return wipLimit !== undefined && count > wipLimit;
}

/**
 * Whether a move actually changes anything — dropping a card back on its own
 * column is a no-op the component can skip (avoids a spurious onMove).
 */
export function isRealMove(fromColumnId: string, toColumnId: string): boolean {
  return fromColumnId !== toColumnId;
}
