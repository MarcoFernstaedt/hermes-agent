import { useEffect, useRef } from "react";
import { LoaderCircle } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Bottom-of-list loader for windowed lists. While more rows exist it
 * renders an invisible sentinel that calls `onLoadMore` as it scrolls
 * into view (plus a spinner while a load is in flight); once the list is
 * exhausted it renders a quiet end-of-list divider so the user knows
 * scrolling further won't produce more.
 */
export function LoadMoreSentinel({
  hasMore,
  loading,
  onLoadMore,
  endLabel = "No more items",
  className,
}: {
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
  /** Divider text once everything is loaded, e.g. "No more sessions". */
  endLabel?: string;
  className?: string;
}) {
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!hasMore || loading) return;
    const node = sentinelRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          onLoadMore();
        }
      },
      // Start fetching shortly before the user actually reaches the end.
      { rootMargin: "240px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, loading, onLoadMore]);

  if (!hasMore && !loading) {
    return (
      <div
        role="note"
        className={cn(
          "flex items-center gap-3 py-3 text-xs tracking-wide text-text-tertiary",
          className,
        )}
      >
        <span aria-hidden className="h-px flex-1 bg-current/15" />
        {endLabel}
        <span aria-hidden className="h-px flex-1 bg-current/15" />
      </div>
    );
  }

  return (
    <div ref={sentinelRef} className={cn("flex justify-center py-3", className)}>
      {loading && (
        <span
          className="inline-flex items-center gap-2 text-xs text-text-secondary"
          aria-busy="true"
          aria-live="polite"
        >
          <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" />
          Loading more…
        </span>
      )}
    </div>
  );
}
