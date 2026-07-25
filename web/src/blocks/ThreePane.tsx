import { useState, type ReactNode } from "react";
import { PanelRight } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * ThreePane — the desktop workhorse layout: a fixed-width list rail, a flexible
 * detail pane, and an optional collapsible context pane on the right. Used
 * wherever a working area is "pick from a list → read/act on one → see related
 * context" (Vault, generated record areas). Panes scroll independently.
 */
export function ThreePane({
  list,
  detail,
  context,
  listWidth = "20rem",
  contextWidth = "18rem",
  className,
}: {
  list: ReactNode;
  detail: ReactNode;
  context?: ReactNode;
  listWidth?: string;
  contextWidth?: string;
  className?: string;
}) {
  const [showContext, setShowContext] = useState(true);

  return (
    <div className={cn("flex min-h-0 gap-3", className)}>
      <aside
        className="min-h-0 shrink-0 overflow-y-auto rounded-lg border border-border"
        style={{ width: listWidth }}
      >
        {list}
      </aside>

      <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto rounded-lg border border-border">
        {context && (
          <button
            type="button"
            onClick={() => setShowContext((v) => !v)}
            aria-pressed={showContext}
            title={showContext ? "Hide context" : "Show context"}
            className="absolute right-2 top-2 z-10 rounded-md p-1 text-text-tertiary hover:bg-midground/10 hover:text-foreground"
          >
            <PanelRight className="size-4" aria-hidden />
          </button>
        )}
        {detail}
      </main>

      {context && showContext && (
        <aside
          className="min-h-0 shrink-0 overflow-y-auto rounded-lg border border-border"
          style={{ width: contextWidth }}
        >
          {context}
        </aside>
      )}
    </div>
  );
}
