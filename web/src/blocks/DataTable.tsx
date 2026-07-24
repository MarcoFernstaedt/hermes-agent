import {
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  compareValues,
  headerCheckboxState,
  renderValue,
  toggleAll,
  toggleRow,
  type DataColumn,
} from "./data-table-model";

/**
 * DataTable — the workhorse collection block. Sortable columns, resizable
 * columns, multi-select with a tri-state header checkbox, inline-editable
 * cells, and optional row virtualization for large sets, all driven from one
 * declarative `DataColumn[]`. Rendering runs on TanStack Table; the app-facing
 * sort/selection/format semantics come from data-table-model (unit-tested).
 */
export interface DataTableProps<T> {
  columns: DataColumn<T>[];
  data: T[];
  /** Stable id per row (selection key + React key). */
  getRowId: (row: T) => string;
  /** Show a leading multi-select checkbox column. */
  selectable?: boolean;
  /** Controlled selection; when omitted the table self-manages it. */
  selectedIds?: Set<string>;
  onSelectionChange?: (ids: Set<string>) => void;
  /** Inline edit committed for an editable cell. */
  onEditCell?: (rowId: string, columnId: string, value: string) => void;
  /** Row click (ignored on the checkbox / edit inputs). */
  onRowClick?: (row: T) => void;
  /** Virtualize rows — for hundreds+ of rows. Needs a bounded-height parent. */
  virtualize?: boolean;
  /** Estimated row height (px) for the virtualizer. */
  rowHeight?: number;
  /** Shown when there are no rows. */
  empty?: ReactNode;
  className?: string;
}

export function DataTable<T>({
  columns,
  data,
  getRowId,
  selectable = false,
  selectedIds,
  onSelectionChange,
  onEditCell,
  onRowClick,
  virtualize = false,
  rowHeight = 40,
  empty,
  className,
}: DataTableProps<T>) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [internalSelection, setInternalSelection] = useState<Set<string>>(new Set());
  const selection = selectedIds ?? internalSelection;

  const setSelection = (next: Set<string>) => {
    if (onSelectionChange) onSelectionChange(next);
    if (selectedIds === undefined) setInternalSelection(next);
  };

  const allIds = useMemo(() => data.map(getRowId), [data, getRowId]);

  const tableColumns = useMemo<ColumnDef<T>[]>(() => {
    return columns.map((col) => ({
      id: col.id,
      header: col.header,
      accessorFn: (row) => col.accessor(row),
      enableSorting: col.sortable !== false,
      size: col.width,
      sortingFn: (a, b) =>
        compareValues(
          col.accessor(a.original),
          col.accessor(b.original),
        ),
      meta: { column: col },
    }));
  }, [columns]);

  // TanStack Table's hook returns non-memoizable functions; the React Compiler
  // deliberately skips memoizing here, which is the intended usage.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data,
    columns: tableColumns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    columnResizeMode: "onChange",
    getRowId: (row) => getRowId(row),
  });

  const rows = table.getRowModel().rows;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
    enabled: virtualize,
  });

  const headerState = headerCheckboxState(selection, allIds);

  const renderCheckboxHeader = () => (
    <th className="w-10 px-2" scope="col">
      <input
        type="checkbox"
        aria-label={headerState === "all" ? "Clear selection" : "Select all rows"}
        checked={headerState === "all"}
        ref={(el) => {
          if (el) el.indeterminate = headerState === "some";
        }}
        onChange={() => setSelection(toggleAll(selection, allIds))}
        className="size-3.5 cursor-pointer accent-[var(--imperator-gold,#e8c87a)]"
      />
    </th>
  );

  const renderRowCells = (row: (typeof rows)[number]) => (
    <>
      {selectable && (
        <td className="w-10 px-2" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            aria-label={`Select row`}
            checked={selection.has(row.id)}
            onChange={() => setSelection(toggleRow(selection, row.id))}
            className="size-3.5 cursor-pointer accent-[var(--imperator-gold,#e8c87a)]"
          />
        </td>
      )}
      {row.getVisibleCells().map((cell) => {
        const col = (cell.column.columnDef.meta as { column: DataColumn<T> })
          .column;
        return (
          <td
            key={cell.id}
            style={{ width: cell.column.getSize() }}
            className={cn(
              "truncate px-3 py-2 text-sm",
              col.align === "right" && "text-right",
              col.align === "center" && "text-center",
            )}
          >
            <CellContent
              col={col}
              row={row.original}
              rowId={row.id}
              onEditCell={onEditCell}
            />
          </td>
        );
      })}
    </>
  );

  const virtualRows = virtualizer.getVirtualItems();

  return (
    <div
      ref={scrollRef}
      className={cn(
        // h-full so the scroll viewport is bounded by its parent — required
        // for row virtualization to window instead of rendering every row.
        "h-full min-h-0 overflow-auto rounded-md border border-border",
        className,
      )}
    >
      <table
        className="w-full border-collapse"
        style={{ width: table.getTotalSize() || undefined }}
      >
        <thead className="sticky top-0 z-10 bg-background-base">
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id} className="border-b border-border">
              {selectable && renderCheckboxHeader()}
              {group.headers.map((header) => {
                const col = (header.column.columnDef.meta as {
                  column: DataColumn<T>;
                }).column;
                const canSort = header.column.getCanSort();
                const dir = header.column.getIsSorted();
                return (
                  <th
                    key={header.id}
                    scope="col"
                    style={{ width: header.getSize() }}
                    className={cn(
                      "relative select-none px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-text-secondary",
                      col.align === "right" && "text-right",
                      col.align === "center" && "text-center",
                    )}
                  >
                    <button
                      type="button"
                      disabled={!canSort}
                      onClick={header.column.getToggleSortingHandler()}
                      className={cn(
                        "inline-flex items-center gap-1",
                        canSort && "cursor-pointer hover:text-foreground",
                      )}
                    >
                      {flexRender(
                        header.column.columnDef.header,
                        header.getContext(),
                      )}
                      {canSort &&
                        (dir === "asc" ? (
                          <ArrowUp className="size-3" aria-hidden />
                        ) : dir === "desc" ? (
                          <ArrowDown className="size-3" aria-hidden />
                        ) : (
                          <ChevronsUpDown className="size-3 opacity-40" aria-hidden />
                        ))}
                    </button>
                    {header.column.getCanResize() && (
                      <span
                        onMouseDown={header.getResizeHandler()}
                        onTouchStart={header.getResizeHandler()}
                        className="absolute right-0 top-0 h-full w-1 cursor-col-resize select-none touch-none bg-transparent hover:bg-midground/40"
                        aria-hidden
                      />
                    )}
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody
          style={
            virtualize
              ? { height: virtualizer.getTotalSize(), position: "relative" }
              : undefined
          }
        >
          {rows.length === 0 ? (
            <tr>
              <td
                colSpan={columns.length + (selectable ? 1 : 0)}
                className="p-8 text-center text-sm text-text-tertiary"
              >
                {empty ?? "No rows."}
              </td>
            </tr>
          ) : virtualize ? (
            virtualRows.map((vr) => {
              const row = rows[vr.index];
              return (
                <tr
                  key={row.id}
                  data-index={vr.index}
                  onClick={() => onRowClick?.(row.original)}
                  className={cn(
                    "absolute flex w-full border-b border-border/60",
                    onRowClick && "cursor-pointer hover:bg-midground/5",
                    selection.has(row.id) && "bg-primary/10",
                  )}
                  style={{ transform: `translateY(${vr.start}px)`, height: rowHeight }}
                >
                  {renderRowCells(row)}
                </tr>
              );
            })
          ) : (
            rows.map((row) => (
              <tr
                key={row.id}
                onClick={() => onRowClick?.(row.original)}
                className={cn(
                  "border-b border-border/60",
                  onRowClick && "cursor-pointer hover:bg-midground/5",
                  selection.has(row.id) && "bg-primary/10",
                )}
              >
                {renderRowCells(row)}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

/** One cell: custom renderer, inline editor, or default text. */
function CellContent<T>({
  col,
  row,
  rowId,
  onEditCell,
}: {
  col: DataColumn<T>;
  row: T;
  rowId: string;
  onEditCell?: (rowId: string, columnId: string, value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const raw = col.accessor(row);

  if (col.editable && onEditCell) {
    if (editing) {
      return (
        <input
          autoFocus
          defaultValue={renderValue(raw)}
          onBlur={(e) => {
            setEditing(false);
            if (e.target.value !== renderValue(raw))
              onEditCell(rowId, col.id, e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") setEditing(false);
          }}
          onClick={(e) => e.stopPropagation()}
          className="w-full rounded border border-primary/40 bg-transparent px-1 py-0.5 text-sm outline-none"
        />
      );
    }
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setEditing(true);
        }}
        className="block w-full cursor-text truncate rounded px-1 py-0.5 text-left hover:bg-midground/10"
        title="Click to edit"
      >
        {col.cell ? col.cell(row) : renderValue(raw)}
      </button>
    );
  }

  return <>{col.cell ? col.cell(row) : renderValue(raw)}</>;
}
