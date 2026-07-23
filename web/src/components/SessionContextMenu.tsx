import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

export interface ContextMenuAction {
  /** Stable key for React and for skipping the divider. */
  key: string;
  label: string;
  icon?: ReactNode;
  destructive?: boolean;
  onSelect: () => void;
}

/**
 * A lightweight, accessible context menu for session rows.
 *
 * Opened by right-click, long-press, or a keyboard-reachable kebab button
 * (the last of these is what makes the row actions usable with a screen
 * reader — pointer gestures are only progressive enhancement). Renders as a
 * `role="menu"` in a portal so it escapes the row's overflow clipping, traps
 * arrow-key navigation between items, closes on Escape / outside-click /
 * scroll, and restores focus to the trigger on close.
 */
export function SessionContextMenu({
  x,
  y,
  actions,
  onClose,
}: {
  x: number;
  y: number;
  actions: ContextMenuAction[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // Keep the menu on-screen: flip/clamp against the viewport once measured.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 8;
    let left = x;
    let top = y;
    if (left + rect.width > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - rect.width - margin);
    }
    if (top + rect.height > window.innerHeight - margin) {
      top = Math.max(margin, window.innerHeight - rect.height - margin);
    }
    setPos({ left, top });
    // Focus the first item so keyboard/screen-reader users land inside.
    const first = el.querySelector<HTMLButtonElement>("[role='menuitem']");
    first?.focus();
  }, [x, y]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = ref.current;
      if (!el) return;
      const items = Array.from(
        el.querySelectorAll<HTMLButtonElement>("[role='menuitem']"),
      );
      if (items.length === 0) return;
      const current = document.activeElement as HTMLElement | null;
      const idx = items.indexOf(current as HTMLButtonElement);
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        items[(idx + 1 + items.length) % items.length]?.focus();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        items[(idx - 1 + items.length) % items.length]?.focus();
      } else if (e.key === "Home") {
        e.preventDefault();
        items[0]?.focus();
      } else if (e.key === "End") {
        e.preventDefault();
        items[items.length - 1]?.focus();
      } else if (e.key === "Tab") {
        // A menu is modal-ish; keep focus inside rather than tabbing away.
        e.preventDefault();
      }
    };
    const onPointerDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onScroll = () => onClose();
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-orientation="vertical"
      style={{ left: pos.left, top: pos.top }}
      className={cn(
        "fixed z-[100] min-w-[11rem] overflow-hidden rounded-lg border border-border/60",
        "bg-background/95 p-1 shadow-xl backdrop-blur-md",
      )}
    >
      {actions.map((action) => (
        <button
          key={action.key}
          type="button"
          role="menuitem"
          tabIndex={-1}
          onClick={() => {
            onClose();
            action.onSelect();
          }}
          className={cn(
            "flex w-full items-center gap-2.5 rounded px-2.5 py-1.5 text-left text-sm",
            "outline-none transition-colors",
            action.destructive
              ? "text-destructive hover:bg-destructive/10 focus-visible:bg-destructive/10"
              : "text-foreground hover:bg-midground/10 focus-visible:bg-midground/10",
          )}
        >
          {action.icon && (
            <span className="grid h-4 w-4 shrink-0 place-items-center" aria-hidden>
              {action.icon}
            </span>
          )}
          <span className="min-w-0 flex-1 truncate">{action.label}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}
