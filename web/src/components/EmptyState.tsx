import type { ComponentType, ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * A consistent empty / no-selection state for detail panes and lists. A quiet
 * icon, a one-line title, and an optional hint keep generated and module
 * surfaces from reading as bare scaffolding when there's nothing selected yet.
 */
export function EmptyState({
  icon: Icon,
  title,
  hint,
  action,
  className,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  hint?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex h-full flex-col items-center justify-center gap-2 p-8 text-center",
        className,
      )}
    >
      <Icon className="size-8 text-text-tertiary" aria-hidden />
      <p className="text-sm font-medium text-text-secondary">{title}</p>
      {hint && <p className="max-w-xs text-xs text-text-tertiary">{hint}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
