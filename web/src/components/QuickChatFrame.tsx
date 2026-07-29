import { useEffect, useRef } from "react";
import { Maximize2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  captureFocus,
  restoreFocus,
  type ChatPresentation,
  type FocusToken,
} from "@/lib/quickChat";

/**
 * The frame quick chat renders in — and nothing else.
 *
 * This component deliberately contains no chat logic. It wraps the *already
 * mounted* `ChatPage`, which the shell keeps alive across every route, so the
 * overlay and the full page are one instance with one session. Putting a
 * composer or a transcript in here would create the second session the brief
 * forbids.
 *
 * Its whole job is the frame: appear without unmounting what is underneath,
 * trap focus while open, and on close put focus back exactly where it was.
 */
export function QuickChatFrame({
  presentation,
  onClose,
  onPromote,
  children,
}: {
  presentation: ChatPresentation;
  onClose: () => void;
  onPromote: () => void;
  children: React.ReactNode;
}) {
  const open = presentation === "overlay";
  const panelRef = useRef<HTMLDivElement | null>(null);
  const returnTo = useRef<FocusToken | null>(null);

  // Capture on open, restore on close. The capture happens before the panel
  // takes focus, so what we return to is where the owner actually was.
  useEffect(() => {
    if (!open) return;
    returnTo.current = captureFocus();
    const timer = window.setTimeout(() => {
      panelRef.current?.querySelector<HTMLElement>("textarea, input, [tabindex]")?.focus();
    }, 0);
    return () => {
      window.clearTimeout(timer);
      restoreFocus(returnTo.current);
      returnTo.current = null;
    };
  }, [open]);

  // Escape closes. Registered on the panel rather than the document so it does
  // not swallow Escape from anything else while chat happens to be open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    const node = panelRef.current;
    node?.addEventListener("keydown", onKey);
    return () => node?.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // `full` renders the children plainly — the page owns the layout. `hidden`
  // still renders them, off-screen: unmounting is what would kill the session.
  if (presentation !== "overlay") return <>{children}</>;

  return (
    <div
      className="pointer-events-none fixed inset-0 z-40 flex items-end justify-end p-3 sm:p-5"
      // Not a modal: the surface underneath stays visible and readable, which
      // is the point of "one interaction away" rather than "instead of".
      role="region"
      aria-label="Quick chat"
    >
      <div
        ref={panelRef}
        className={cn(
          "motion-enter pointer-events-auto flex h-[min(32rem,80vh)] w-[min(28rem,92vw)] flex-col",
          "overflow-hidden rounded-xl border border-current/15 bg-background shadow-2xl",
          "transition-[transform,opacity] duration-[var(--motion-panel)] ease-[var(--ease-spring)]",
        )}
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-current/10 px-3 py-2">
          <h2 className="font-sans text-xs font-semibold uppercase tracking-[0.11em] text-text-secondary">
            Imperator
          </h2>
          <button
            type="button"
            onClick={onPromote}
            aria-label="Open the full conversation"
            title="Open the full conversation"
            className="ml-auto rounded-md p-1.5 text-text-tertiary transition-colors hover:text-midground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-midground/40"
          >
            <Maximize2 className="size-4" aria-hidden />
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close quick chat"
            title="Close quick chat (Escape)"
            className="rounded-md p-1.5 text-text-tertiary transition-colors hover:text-midground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-midground/40"
          >
            <X className="size-4" aria-hidden />
          </button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </div>
    </div>
  );
}
