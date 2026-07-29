import type { ComponentType } from "react";

import { cn } from "@/lib/utils";

/**
 * StatBar — a compact row of headline numbers (counts, totals, rates) for the
 * top of a list or dashboard surface. Keeps generated areas from opening on an
 * empty header by giving the key figures a consistent home.
 */
export interface Stat {
  label: string;
  value: string | number;
  hint?: string;
  icon?: ComponentType<{ className?: string }>;
  tone?: "neutral" | "gold" | "positive" | "warning";
}

const TONE: Record<NonNullable<Stat["tone"]> & string, string> = {
  neutral: "text-foreground",
  gold: "text-midground",
  positive: "text-success",
  warning: "text-warning",
};

export function StatBar({ stats, className }: { stats: Stat[]; className?: string }) {
  return (
    <div
      className={cn(
        "grid gap-3 sm:grid-cols-2 lg:grid-cols-4",
        className,
      )}
    >
      {stats.map((stat) => {
        const Icon = stat.icon;
        return (
          <div
            key={stat.label}
            className="rounded-lg border border-border p-3"
          >
            <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-text-tertiary">
              {Icon && <Icon className="size-3.5" aria-hidden />}
              {stat.label}
            </div>
            <div className={cn("mt-1 text-2xl font-semibold tabular-nums", TONE[stat.tone ?? "neutral"])}>
              {stat.value}
            </div>
            {stat.hint && (
              <div className="mt-0.5 text-xs text-text-tertiary">{stat.hint}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}
