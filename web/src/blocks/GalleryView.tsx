import { staggerDelay } from "@/lib/motion";
import { cn } from "@/lib/utils";

export interface GalleryViewProps<T> {
  items: T[];
  getItemId: (item: T) => string;
  renderCard: (item: T) => React.ReactNode;
  onSelect?: (item: T) => void;
  className?: string;
  /** Accessible name for the grid. */
  label?: string;
}

/**
 * GalleryView — a card grid for record sets that read better as objects than as
 * rows: a reading list, saved media, anything with a title and a shape.
 *
 * Semantics are a **list**, not a grid: the cards flow responsively and have no
 * meaningful column relationship, so a list is what a screen reader should
 * announce. Each card is a real button, so keyboard and voice control reach it
 * without a pointer gesture. Entrances cascade briefly (capped) so a batch
 * arriving feels alive rather than dumped.
 */
export function GalleryView<T>({
  items,
  getItemId,
  renderCard,
  onSelect,
  className,
  label = "Records",
}: GalleryViewProps<T>) {
  return (
    <ul
      aria-label={label}
      className={cn(
        "grid gap-3 overflow-y-auto",
        // Recon at 1920×1080: "two very wide sparse cards" leaving most of the
        // page empty. A 15rem floor with 1fr tracks lets a handful of records
        // stretch across the full width — the grid fills the row rather than
        // keeping cards card-sized. Cap the track so a card stays a card and
        // extra width becomes more columns, not wider ones.
        "grid-cols-[repeat(auto-fill,minmax(min(100%,13rem),18rem))]",
        className,
      )}
    >
      {items.map((item, i) => {
        const id = getItemId(item);
        const content = (
          <div className="flex h-full flex-col gap-1 text-left">{renderCard(item)}</div>
        );
        return (
          <li
            key={id}
            className="motion-enter"
            style={{ animationDelay: `${staggerDelay(i)}ms` }}
          >
            {onSelect ? (
              <button
                type="button"
                onClick={() => onSelect(item)}
                className={cn(
                  "h-full w-full rounded-lg border border-current/10 bg-midground/[0.02] p-3",
                  "text-left transition-colors hover:border-current/25 hover:bg-midground/[0.05]",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-midground/50",
                )}
              >
                {content}
              </button>
            ) : (
              <div className="h-full rounded-lg border border-current/10 bg-midground/[0.02] p-3">
                {content}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
