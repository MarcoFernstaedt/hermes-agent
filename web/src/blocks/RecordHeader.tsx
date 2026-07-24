import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * RecordHeader — the top of a record surface: title, optional subtitle, a
 * status pill, and a right-aligned action row. Small but load-bearing: a bare
 * title is exactly what makes a generated record read as scaffolding, so this
 * gives every area a consistent, finished header.
 */
export interface RecordHeaderProps {
  title: string;
  subtitle?: ReactNode;
  status?: { label: string; tone?: "neutral" | "gold" | "positive" | "warning" };
  actions?: ReactNode;
  className?: string;
}

const TONE: Record<NonNullable<RecordHeaderProps["status"]>["tone"] & string, string> = {
  neutral: "bg-midground/15 text-text-secondary",
  gold: "bg-midground/15 text-midground",
  positive: "bg-success/15 text-success",
  warning: "bg-warning/15 text-warning",
};

export function RecordHeader({
  title,
  subtitle,
  status,
  actions,
  className,
}: RecordHeaderProps) {
  return (
    <header
      className={cn(
        "flex flex-wrap items-start justify-between gap-3 border-b border-border pb-3",
        className,
      )}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h1 className="truncate text-lg font-semibold">{title}</h1>
          {status && (
            <span
              className={cn(
                "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium capitalize",
                TONE[status.tone ?? "neutral"],
              )}
            >
              {status.label}
            </span>
          )}
        </div>
        {subtitle && (
          <p className="mt-0.5 truncate text-sm text-text-secondary">{subtitle}</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
    </header>
  );
}
