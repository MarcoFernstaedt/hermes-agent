import { useEffect, useMemo, useState } from "react";
import { Boxes } from "lucide-react";

import { usePageHeader } from "@/contexts/usePageHeader";
import { DataTable, EmptyState, type DataColumn } from "@/blocks";
import { cn } from "@/lib/utils";

/**
 * Blocks gallery — the story-style demo surface for the Intelligence Hub's
 * reusable block catalogue (Phase A). Each block is exercised with sample data
 * so its behaviour is inspectable in the real app shell. Not part of primary
 * navigation; reachable via the command palette and a direct /blocks route.
 */

interface DemoRow {
  id: string;
  company: string;
  role: string;
  status: string;
  salary: number | null;
  applied: string;
}

const STATUSES = ["saved", "applied", "screening", "interview", "offer"];

function makeRows(n: number): DemoRow[] {
  const companies = ["Acme", "Globex", "Initech", "Umbrella", "Stark", "Wayne", "Hooli", "Pied Piper"];
  const roles = ["Support Engineer", "Solutions Eng", "TAM", "Impl Consultant", "CSM"];
  return Array.from({ length: n }, (_, i) => ({
    id: String(i + 1),
    company: companies[i % companies.length],
    role: roles[i % roles.length],
    status: STATUSES[i % STATUSES.length],
    salary: i % 7 === 0 ? null : 90000 + (i % 11) * 5000,
    applied: `2026-07-${String((i % 27) + 1).padStart(2, "0")}`,
  }));
}

export default function BlocksGalleryPage() {
  const { setTitle } = usePageHeader();
  useEffect(() => setTitle("Blocks"), [setTitle]);

  const [rows, setRows] = useState<DemoRow[]>(() => makeRows(12));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [big, setBig] = useState(false);

  const columns = useMemo<DataColumn<DemoRow>[]>(
    () => [
      { id: "company", header: "Company", accessor: (r) => r.company, editable: true },
      { id: "role", header: "Role", accessor: (r) => r.role, editable: true },
      {
        id: "status",
        header: "Status",
        accessor: (r) => r.status,
        cell: (r) => <StatusPill status={r.status} />,
      },
      {
        id: "salary",
        header: "Salary",
        align: "right",
        accessor: (r) => r.salary,
        cell: (r) =>
          r.salary == null ? (
            <span className="text-text-tertiary">—</span>
          ) : (
            `$${r.salary.toLocaleString()}`
          ),
      },
      { id: "applied", header: "Applied", accessor: (r) => r.applied },
    ],
    [],
  );

  const data = big ? makeRows(2000) : rows;

  const editCell = (rowId: string, columnId: string, value: string) => {
    setRows((prev) =>
      prev.map((r) => (r.id === rowId ? { ...r, [columnId]: value } : r)),
    );
  };

  return (
    <div className="mx-auto flex min-h-0 max-w-5xl flex-col gap-4 p-4 sm:p-6">
      <header className="flex items-center gap-2">
        <Boxes className="size-5 text-midground" aria-hidden />
        <div>
          <h1 className="text-lg font-semibold">Blocks gallery</h1>
          <p className="text-sm text-text-secondary">
            Reusable UI pieces the Intelligence Hub composes working areas from.
          </p>
        </div>
      </header>

      <section aria-labelledby="datatable-heading" className="flex min-h-0 flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="datatable-heading" className="text-sm font-semibold uppercase tracking-wide text-text-secondary">
            DataTable
          </h2>
          <div className="flex items-center gap-2 text-xs text-text-tertiary">
            <span>{selected.size} selected</span>
            <button
              type="button"
              onClick={() => {
                setBig((b) => !b);
                setSelected(new Set());
              }}
              className={cn(
                "rounded border border-border px-2 py-1 font-medium transition-colors hover:bg-midground/10",
                big && "bg-primary/10 text-primary",
              )}
            >
              {big ? "2,000 rows (virtualized)" : "12 rows"}
            </button>
          </div>
        </div>
        <p className="text-xs text-text-tertiary">
          Click a header to sort; drag a header edge to resize; double the row
          count to see virtualization; company and role cells are inline-editable.
        </p>
        <div className="h-[60vh] min-h-0">
          <DataTable
            columns={columns}
            data={data}
            getRowId={(r) => r.id}
            selectable
            selectedIds={selected}
            onSelectionChange={setSelected}
            onEditCell={big ? undefined : editCell}
            virtualize={big}
            empty={<EmptyState icon={Boxes} title="No rows" hint="Nothing to show yet." />}
          />
        </div>
      </section>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  return (
    <span className="rounded-full bg-midground/15 px-2 py-0.5 text-xs font-medium capitalize text-midground">
      {status}
    </span>
  );
}
