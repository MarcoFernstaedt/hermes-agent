import { useEffect, useMemo, useState } from "react";
import { Button } from "@nous-research/ui/ui/components/button";
import { Segmented } from "@nous-research/ui/ui/components/segmented";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { Toast } from "@nous-research/ui/ui/components/toast";
import { useToast } from "@nous-research/ui/hooks/use-toast";
import { Plus, X } from "lucide-react";

import {
  BoardView,
  DataTable,
  EmptyState,
  FormFromSchema,
  StatBar,
  type Stat,
} from "@/blocks";
import { usePageHeader } from "@/contexts/usePageHeader";
import { useEntityEvents } from "@/hooks/useEntityEvents";
import { useModalBehavior } from "@/hooks/useModalBehavior";
import { api } from "@/lib/api";
import { useData } from "@/lib/use-data";
import { cn } from "@/lib/utils";
import {
  boardColumns,
  canTransition,
  countByState,
  defaultView,
  flatten,
  labelCase,
  stateLabels,
  tableColumns,
  toData,
  type FlatRecord,
} from "./capability-model";
import { entityTypeOf, type Capability } from "./types";

/**
 * CapabilityArea — renders a complete, live working area from a Capability
 * declaration over the generic entity store: a view switcher (board/table), a
 * stat row, create + edit forms, and drag-to-transition on the board. It reads
 * and writes /api/entities and refreshes in place on entity events, so a new
 * area needs a declaration, not code.
 */
export function CapabilityArea({ capability }: { capability: Capability }) {
  const type = entityTypeOf(capability);
  const { setTitle } = usePageHeader();
  useEffect(() => setTitle(capability.label), [setTitle, capability.label]);

  const { toast, showToast } = useToast();
  const [viewId, setViewId] = useState(() => defaultView(capability).id);
  const [editing, setEditing] = useState<FlatRecord | "new" | null>(null);

  const list = useData(`entities:${type}`, () => api.listEntities(type));
  const refresh = () => list.refetch({ force: true });
  useEntityEvents(type, refresh);

  const records = useMemo<FlatRecord[]>(
    () => (list.data?.items ?? []).map(flatten),
    [list.data],
  );

  const view =
    capability.views.find((v) => v.id === viewId) ?? defaultView(capability);
  const lifecycle = capability.lifecycle;
  // Board columns, the StatBar and toast copy all read a state's human label
  // from the status field's declared options (falling back to label-casing) so
  // every surface names a state the same way the edit form's dropdown does.
  const labels = stateLabels(capability);
  const stateLabel = (s: string) => labels[s] ?? labelCase(s);

  const create = async (values: Record<string, unknown>) => {
    // New records enter the lifecycle at its initial state unless the form set
    // one, so they land in a board column instead of being unplaced.
    const payload = { ...values };
    if (lifecycle && !payload[lifecycle.field]) {
      payload[lifecycle.field] = lifecycle.initial;
    }
    try {
      await api.createEntity(type, payload);
      setEditing(null);
      showToast(`${capability.label} created`, "success");
      refresh();
    } catch {
      showToast("Could not create", "error");
    }
  };

  const update = async (record: FlatRecord, values: Record<string, unknown>) => {
    try {
      await api.updateEntity(type, record.id, values, record.__version);
      setEditing(null);
      showToast("Saved", "success");
      refresh();
    } catch {
      showToast("Could not save — it may have changed elsewhere.", "error");
      refresh();
    }
  };

  const moveCard = async (id: string, toColumn: string) => {
    const record = records.find((r) => r.id === id);
    if (!record || !lifecycle) return;
    const from = String(record[lifecycle.field] ?? "");
    if (!canTransition(lifecycle, from, toColumn)) {
      showToast(`Can't move from ${stateLabel(from)} to ${stateLabel(toColumn)}`, "error");
      refresh();
      return;
    }
    try {
      await api.updateEntity(
        type,
        id,
        { ...toData(record), [lifecycle.field]: toColumn },
        record.__version,
      );
      refresh();
    } catch {
      showToast("Move failed — refreshing.", "error");
      refresh();
    }
  };

  const stats: Stat[] = lifecycle
    ? (() => {
        const counts = countByState(records, lifecycle);
        return lifecycle.states.map((s) => ({
          label: stateLabel(s),
          value: counts[s] ?? 0,
        }));
      })()
    : [{ label: "Total", value: records.length }];

  return (
    <div className="mx-auto flex min-h-0 max-w-6xl flex-col gap-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {capability.icon && <capability.icon className="size-5 text-midground" />}
          <h1 className="text-lg font-semibold">{capability.label}</h1>
        </div>
        <div className="flex items-center gap-2">
          {capability.views.length > 1 && (
            <Segmented
              value={viewId}
              onChange={setViewId}
              options={capability.views.map((v) => ({
                value: v.id,
                label: labelCase(v.id),
              }))}
            />
          )}
          <Button prefix={<Plus />} onClick={() => setEditing("new")}>
            New
          </Button>
        </div>
      </header>

      <StatBar stats={stats} />

      {list.isLoading ? (
        <div className="flex items-center justify-center gap-2 p-10 text-sm text-text-secondary">
          <Spinner /> Loading…
        </div>
      ) : records.length === 0 ? (
        <EmptyState
          icon={capability.icon ?? Plus}
          title={`No ${capability.label.toLowerCase()} yet`}
          hint="Create the first record to get started."
          action={
            <Button size="sm" prefix={<Plus />} onClick={() => setEditing("new")}>
              New {capability.label}
            </Button>
          }
        />
      ) : view.kind === "board" && lifecycle ? (
        <div className="h-[62vh] min-h-0">
          <BoardView
            className="h-full"
            columns={boardColumns(lifecycle, labels)}
            items={records}
            getItemId={(r) => r.id}
            getColumnId={(r) => String(r[lifecycle.field] ?? "")}
            onMove={moveCard}
            renderCard={(r) => (
              <button
                type="button"
                onClick={() => setEditing(r)}
                className="w-full text-left text-sm"
              >
                <div className="font-medium">{String(r[capability.titleField] ?? "(untitled)")}</div>
                {capability.subtitleField && (
                  <div className="text-xs text-text-tertiary">
                    {String(r[capability.subtitleField] ?? "")}
                  </div>
                )}
              </button>
            )}
          />
        </div>
      ) : (
        <div className="h-[62vh] min-h-0">
          <DataTable
            columns={tableColumns(capability, view)}
            data={records}
            getRowId={(r) => r.id}
            onRowClick={(r) => setEditing(r)}
          />
        </div>
      )}

      {editing && (
        <RecordDialog
          title={editing === "new" ? `New ${capability.label}` : "Edit"}
          onClose={() => setEditing(null)}
        >
          <FormFromSchema
            fields={capability.fields}
            initial={editing === "new" ? undefined : editing}
            submitLabel={editing === "new" ? "Create" : "Save"}
            onCancel={() => setEditing(null)}
            onSubmit={(values) =>
              editing === "new" ? create(values) : update(editing, values)
            }
          />
        </RecordDialog>
      )}

      <Toast toast={toast} />
    </div>
  );
}

function RecordDialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useModalBehavior({ open: true, onClose });
  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center bg-black/60 px-4 pt-[10vh] backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          "w-full max-w-md overflow-hidden rounded-lg border border-border bg-background-base p-4",
          "shadow-[0_24px_64px_-16px_rgba(0,0,0,0.7)] animate-[dialog-in_120ms_ease-out]",
        )}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-text-tertiary hover:bg-midground/10 hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
