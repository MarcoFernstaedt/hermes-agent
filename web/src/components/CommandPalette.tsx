import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { CornerDownLeft, Search } from "lucide-react";

import { useModalBehavior } from "@/hooks/useModalBehavior";
import { fuzzyRank } from "@/lib/fuzzy";
import { cn } from "@/lib/utils";

/**
 * Cmd/Ctrl+K command palette — fuzzy jump to any dashboard destination.
 *
 * Keyboard-first (the pattern users know from Linear/GitHub/Vercel): open
 * with ⌘K / Ctrl+K, type a few characters, Enter to go. Every navigation
 * destination (core pages + plugin tabs) is an item; the section name
 * rides along as a hint and as extra fuzzy-matchable text, so "auto cron"
 * and "crn" both land on Cron.
 */

export interface CommandPaletteItem {
  id: string;
  label: string;
  /** Section / group name shown as a right-aligned hint. */
  hint?: string;
  /** Extra text the fuzzy matcher may hit (e.g. section, aliases). */
  keywords?: string;
  icon?: ComponentType<{ className?: string }>;
  run(): void;
}

/** Pure ranking used by the palette (exported for tests). */
export function rankPaletteItems(
  items: readonly CommandPaletteItem[],
  query: string,
): CommandPaletteItem[] {
  return fuzzyRank(
    items,
    query,
    (item) => `${item.label} ${item.keywords ?? ""}`,
  ).map((ranked) => ranked.item);
}

export function CommandPalette({
  open,
  onClose,
  items,
}: {
  open: boolean;
  onClose: () => void;
  items: CommandPaletteItem[];
}) {
  const containerRef = useModalBehavior({ open, onClose });
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);

  const results = useMemo(() => rankPaletteItems(items, query), [items, query]);
  const clampedSelection = Math.min(selected, Math.max(results.length - 1, 0));

  // Fresh query + selection every time the palette opens.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelected(0);
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    const node = listRef.current?.children[clampedSelection];
    (node as HTMLElement | undefined)?.scrollIntoView?.({ block: "nearest" });
  }, [clampedSelection, results]);

  if (!open) return null;

  const runItem = (item: CommandPaletteItem | undefined) => {
    if (!item) return;
    onClose();
    item.run();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelected((current) => Math.min(current + 1, results.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelected((current) => Math.max(current - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      runItem(results[clampedSelection]);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center bg-black/60 px-4 pt-[12vh] backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className={cn(
          "w-full max-w-lg overflow-hidden rounded-lg",
          "border border-current/25 bg-background-base shadow-[0_24px_64px_-16px_rgba(0,0,0,0.7)]",
          "animate-[dialog-in_120ms_ease-out]",
        )}
      >
        <div className="flex items-center gap-2 border-b border-current/15 px-3">
          <Search className="size-4 shrink-0 text-text-tertiary" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelected(0);
            }}
            onKeyDown={onKeyDown}
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-results"
            aria-activedescendant={
              results[clampedSelection]
                ? `palette-item-${results[clampedSelection].id}`
                : undefined
            }
            placeholder="Jump to…"
            aria-label="Search pages and actions"
            className={cn(
              "min-w-0 flex-1 bg-transparent py-3 text-base text-foreground outline-none",
              "placeholder:text-text-tertiary sm:text-sm",
            )}
          />
          <kbd className="hidden shrink-0 rounded border border-current/20 px-1.5 py-0.5 text-xs text-text-tertiary sm:inline">
            esc
          </kbd>
        </div>

        <ul
          id="command-palette-results"
          ref={listRef}
          role="listbox"
          aria-label="Results"
          className="max-h-[45vh] overflow-y-auto overscroll-contain py-1"
        >
          {results.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-text-tertiary">
              No matches
            </li>
          )}
          {results.map((item, index) => {
            const Icon = item.icon;
            const active = index === clampedSelection;
            return (
              <li
                key={item.id}
                id={`palette-item-${item.id}`}
                role="option"
                aria-selected={active}
                onMouseEnter={() => setSelected(index)}
                onMouseDown={(event) => {
                  // mousedown (not click) so the run happens before the
                  // input's blur can close the palette out from under it.
                  event.preventDefault();
                  runItem(item);
                }}
                className={cn(
                  "flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2",
                  active
                    ? "bg-midground/10 text-midground"
                    : "text-text-secondary",
                )}
              >
                {Icon ? (
                  <Icon className="size-4 shrink-0" aria-hidden />
                ) : (
                  <span className="size-4 shrink-0" aria-hidden />
                )}
                <span className="min-w-0 flex-1 truncate text-sm">
                  {item.label}
                </span>
                {item.hint && (
                  <span className="shrink-0 text-xs tracking-wide text-text-tertiary">
                    {item.hint}
                  </span>
                )}
                {active && (
                  <CornerDownLeft
                    className="size-3.5 shrink-0 text-text-tertiary"
                    aria-hidden
                  />
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>,
    document.body,
  );
}
