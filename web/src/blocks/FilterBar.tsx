import { X } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  activeFilterCount,
  type FilterField,
  type FilterState,
} from "./filter-model";

/**
 * FilterBar — a declarative row of filter dropdowns whose selection produces a
 * FilterState the caller applies with applyFilters (filter-model). One select
 * per field, plus a "clear (N)" affordance when any filter is active.
 */
export function FilterBar<T>({
  fields,
  state,
  onChange,
  className,
}: {
  fields: FilterField<T>[];
  state: FilterState;
  onChange: (next: FilterState) => void;
  className?: string;
}) {
  const active = activeFilterCount(state);

  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      {fields.map((field) => (
        <label key={field.id} className="flex items-center gap-1.5 text-xs">
          <span className="text-text-tertiary">{field.label}</span>
          <select
            aria-label={field.label}
            value={state[field.id] ?? ""}
            onChange={(e) =>
              onChange({ ...state, [field.id]: e.target.value || null })
            }
            className={cn(
              "rounded-md border border-border bg-transparent px-2 py-1 text-sm outline-none",
              "focus-visible:ring-1 focus-visible:ring-primary/40",
              state[field.id] && "border-midground/50 text-midground",
            )}
          >
            <option value="">Any</option>
            {field.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      ))}
      {active > 0 && (
        <button
          type="button"
          onClick={() => onChange({})}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-text-secondary hover:text-foreground"
        >
          <X className="size-3" aria-hidden />
          Clear ({active})
        </button>
      )}
    </div>
  );
}
