import { useMemo } from "react";
import { CalendarClock } from "lucide-react";
import { dayLabel, groupByDay, isToday } from "./agenda-model";
import { staggerDelay } from "@/lib/motion";
import { cn } from "@/lib/utils";

export interface AgendaViewProps<T extends Record<string, unknown>> {
  items: T[];
  /** Field holding the date to group by. */
  dateField: string;
  getItemId: (item: T) => string;
  renderItem: (item: T) => React.ReactNode;
  onSelect?: (item: T) => void;
  className?: string;
  label?: string;
}

/**
 * AgendaView — the date surface, accessible-first by construction.
 *
 * A calendar *grid* is a hostile shape for a screen reader; the linear agenda is
 * the one everyone can navigate, so it is the primary view rather than a
 * fallback. Real headings per day make rotor/heading navigation work, and each
 * day is a labelled list so "next list" jumps by day.
 *
 * Records whose date is missing are shown in an explicit "No date" group rather
 * than dropped — a silently vanished record is worse than an ugly one.
 */
export function AgendaView<T extends Record<string, unknown>>({
  items,
  dateField,
  getItemId,
  renderItem,
  onSelect,
  className,
  label = "Agenda",
}: AgendaViewProps<T>) {
  const { groups, undated } = useMemo(
    () => groupByDay(items, dateField),
    [items, dateField],
  );

  const row = (item: T, index: number) => {
    const content = <div className="flex flex-col text-left">{renderItem(item)}</div>;
    return (
      <li
        key={getItemId(item)}
        className="motion-enter"
        style={{ animationDelay: `${staggerDelay(index)}ms` }}
      >
        {onSelect ? (
          <button
            type="button"
            onClick={() => onSelect(item)}
            className={cn(
              "w-full rounded-md px-2 py-1.5 text-left transition-colors",
              "hover:bg-midground/[0.06]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-midground/50",
            )}
          >
            {content}
          </button>
        ) : (
          <div className="px-2 py-1.5">{content}</div>
        )}
      </li>
    );
  };

  return (
    <div aria-label={label} className={cn("flex flex-col gap-5 overflow-y-auto", className)}>
      {groups.map((group) => {
        const today = isToday(group.date);
        return (
          <section key={group.key} aria-labelledby={`agenda-${group.key}`}>
            <h3
              id={`agenda-${group.key}`}
              className={cn(
                "mb-1.5 flex items-center gap-2 font-sans text-xs font-semibold tracking-[0.08em]",
                // Gold marks the one group that matters: today.
                today ? "text-midground" : "text-text-tertiary",
              )}
            >
              {today && <CalendarClock className="size-3.5" aria-hidden />}
              {dayLabel(group.date)}
              <span className="font-mono-ui font-normal tabular-nums text-text-tertiary">
                {group.items.length}
              </span>
            </h3>
            <ul className="flex flex-col gap-0.5">{group.items.map(row)}</ul>
          </section>
        );
      })}

      {undated.length > 0 && (
        <section aria-labelledby="agenda-undated">
          <h3
            id="agenda-undated"
            className="mb-1.5 font-sans text-xs font-semibold tracking-[0.08em] text-text-tertiary"
          >
            No date{" "}
            <span className="font-mono-ui font-normal tabular-nums">{undated.length}</span>
          </h3>
          <ul className="flex flex-col gap-0.5">{undated.map(row)}</ul>
        </section>
      )}
    </div>
  );
}
