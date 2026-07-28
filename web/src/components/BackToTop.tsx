import { useEffect, useRef, useState } from "react";
import { ArrowUp } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Floating back-to-top affordance for long pages. Mounted once inside the
 * app's scrolling <main>; it appears after the user scrolls a while and
 * glides the page back to the top toolbar where the page's actions live.
 * Hidden on the chat route (chat manages its own scroll).
 */
export function BackToTop() {
  const [visible, setVisible] = useState(false);
  const anchorRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const main = anchorRef.current?.closest("main");
    if (!main) return;
    const onScroll = () => {
      setVisible(main.scrollTop > 600);
    };
    onScroll();
    main.addEventListener("scroll", onScroll, { passive: true });
    return () => main.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <span ref={anchorRef} className="contents">
      {visible && (
        <button
          type="button"
          aria-label="Back to top"
          onClick={() => {
            const main = anchorRef.current?.closest("main");
            const reducedMotion = window.matchMedia(
              "(prefers-reduced-motion: reduce)",
            ).matches;
            main?.scrollTo({
              top: 0,
              behavior: reducedMotion ? "auto" : "smooth",
            });
          }}
          className={cn(
            "fixed right-4 z-40 flex size-10 cursor-pointer items-center justify-center",
            // Clear the mobile bottom tab bar; sit lower on desktop.
            "bottom-[calc(5.25rem+env(safe-area-inset-bottom,0px))] lg:bottom-6",
            "rounded-full border border-primary/40 bg-background-base/90 text-primary shadow-lg backdrop-blur",
            "transition-opacity hover:bg-primary/10",
            "motion-safe:[animation:fade-in_160ms_ease-out]",
          )}
        >
          <ArrowUp className="size-4" />
        </button>
      )}
    </span>
  );
}
