import { useMemo, useState, type ReactNode } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";

import { cn } from "@/lib/utils";
import {
  groupItems,
  isOverLimit,
  isRealMove,
  type BoardColumn,
} from "./board-model";

/**
 * BoardView — a kanban board with drag-between-columns. Items are grouped into
 * declared columns by their column id (typically a lifecycle status); dragging a
 * card to another column calls `onMove(itemId, toColumnId)`, which maps cleanly
 * onto a status transition. Columns show a count, an optional WIP-limit warning,
 * and collapse. Grouping / limit logic is the unit-tested board-model.
 */
export interface BoardViewProps<T> {
  columns: BoardColumn[];
  items: T[];
  getItemId: (item: T) => string;
  getColumnId: (item: T) => string;
  renderCard: (item: T) => ReactNode;
  onMove: (itemId: string, toColumnId: string) => void;
  className?: string;
}

export function BoardView<T>({
  columns,
  items,
  getItemId,
  getColumnId,
  renderCard,
  onMove,
  className,
}: BoardViewProps<T>) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const groups = useMemo(
    () => groupItems(items, columns, getColumnId),
    [items, columns, getColumnId],
  );
  const byId = useMemo(() => {
    const m = new Map<string, T>();
    for (const it of items) m.set(getItemId(it), it);
    return m;
  }, [items, getItemId]);

  const activeItem = activeId ? byId.get(activeId) : undefined;

  const onDragStart = (e: DragStartEvent) => setActiveId(String(e.active.id));
  const onDragEnd = (e: DragEndEvent) => {
    setActiveId(null);
    const item = byId.get(String(e.active.id));
    if (!item || !e.over) return;
    const from = getColumnId(item);
    const to = String(e.over.id);
    if (isRealMove(from, to)) onMove(getItemId(item), to);
  };

  const toggleCollapse = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
      <div className={cn("flex min-h-0 gap-3 overflow-x-auto pb-2", className)}>
        {columns.map((col) => {
          const colItems = groups.get(col.id) ?? [];
          const over = isOverLimit(colItems.length, col.wipLimit);
          const isCollapsed = collapsed.has(col.id);
          return (
            <BoardColumnDroppable
              key={col.id}
              column={col}
              count={colItems.length}
              over={over}
              collapsed={isCollapsed}
              onToggleCollapse={() => toggleCollapse(col.id)}
            >
              {!isCollapsed &&
                colItems.map((item) => (
                  <BoardCard key={getItemId(item)} id={getItemId(item)}>
                    {renderCard(item)}
                  </BoardCard>
                ))}
            </BoardColumnDroppable>
          );
        })}
      </div>
      <DragOverlay dropAnimation={null}>
        {activeItem ? (
          <div className="w-64 rotate-1 rounded-md border border-midground/40 bg-background-base p-2 shadow-lg">
            {renderCard(activeItem)}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function BoardColumnDroppable({
  column,
  count,
  over,
  collapsed,
  onToggleCollapse,
  children,
}: {
  column: BoardColumn;
  count: number;
  over: boolean;
  collapsed: boolean;
  onToggleCollapse: () => void;
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id });
  return (
    <section
      ref={setNodeRef}
      aria-label={column.label}
      className={cn(
        "flex max-h-full flex-col rounded-lg border border-border bg-midground/[0.03]",
        collapsed ? "w-12 shrink-0" : "w-64 shrink-0",
        isOver && "border-midground/50 bg-midground/10",
      )}
    >
      <header
        className={cn(
          "flex items-center gap-1.5 border-b border-border px-2 py-2",
          collapsed && "flex-col",
        )}
      >
        <button
          type="button"
          onClick={onToggleCollapse}
          aria-expanded={!collapsed}
          aria-label={collapsed ? `Expand ${column.label}` : `Collapse ${column.label}`}
          className="text-text-tertiary hover:text-foreground"
        >
          <span className={cn("block text-xs", collapsed && "[writing-mode:vertical-rl]")}>
            {collapsed ? column.label : "⋯"}
          </span>
        </button>
        {!collapsed && (
          <>
            <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">
              {column.label}
            </h3>
            <span
              className={cn(
                "shrink-0 rounded-full px-1.5 py-0.5 text-xs tabular-nums",
                over ? "bg-warning/20 text-warning" : "bg-midground/15 text-text-secondary",
              )}
              title={
                column.wipLimit !== undefined
                  ? `${count} of ${column.wipLimit} (WIP limit)`
                  : `${count}`
              }
            >
              {column.wipLimit !== undefined ? `${count}/${column.wipLimit}` : count}
            </span>
          </>
        )}
      </header>
      {!collapsed && (
        <div className="flex min-h-16 flex-1 flex-col gap-2 overflow-y-auto p-2">
          {children}
        </div>
      )}
    </section>
  );
}

function BoardCard({ id, children }: { id: string; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id });
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={cn(
        "cursor-grab rounded-md border border-border bg-background-base p-2 active:cursor-grabbing",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/40",
        isDragging && "opacity-30",
      )}
    >
      {children}
    </div>
  );
}
