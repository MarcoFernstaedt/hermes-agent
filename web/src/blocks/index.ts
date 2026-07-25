/**
 * Blocks — the catalogue of reusable, capability-agnostic UI pieces the
 * Intelligence Hub composes working areas from. Each block has a typed prop
 * contract and no knowledge of the entity store. See
 * docs/plans/intelligence-hub-architecture.md (Phase A).
 */
export { DataTable, type DataTableProps } from "./DataTable";
export { BoardView, type BoardViewProps } from "./BoardView";
export type { BoardColumn } from "./board-model";
export { ThreePane } from "./ThreePane";
export { FilterBar } from "./FilterBar";
export {
  applyFilters,
  matchesFilters,
  activeFilterCount,
  type FilterField,
  type FilterState,
} from "./filter-model";
export { RecordHeader, type RecordHeaderProps } from "./RecordHeader";
export { FieldGrid } from "./FieldGrid";
export { FormFromSchema } from "./FormFromSchema";
export { StatBar, type Stat } from "./StatBar";
export { EmptyState } from "@/components/EmptyState";
export type { DataColumn, SortDirection } from "./data-table-model";
export { formatField, type FieldDef, type FieldType } from "./fields";
