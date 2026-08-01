/**
 * The first focusable thing on the page, and the only one that is invisible
 * until it matters.
 *
 * Without it, a keyboard or screen-reader user reaches the page's actual
 * content by tabbing through the entire sidebar, every nav item, the profile
 * switcher and the auth widget — on every route change. That is the difference
 * between a dashboard someone uses and one they endure.
 *
 * Three details are load-bearing:
 *
 * **Not `display: none` or `visibility: hidden`.** Either would remove it from
 * the tab order, which is the whole mechanism. It is positioned off-screen and
 * returns on `:focus`.
 *
 * **First in DOM order**, not merely first visually. Tab order follows the DOM,
 * and a skip link that comes after the navigation skips nothing.
 *
 * **A real `<a href="#…">`**, not a button with a scroll handler. The browser's
 * own fragment navigation moves the *focus*, not just the scroll position, and
 * focus is what a screen reader follows. `tabIndex={-1}` on the target is what
 * lets a non-interactive `<main>` accept it.
 */
export function SkipToMain({ targetId = "main-content" }: { targetId?: string }) {
  return (
    <a
      href={`#${targetId}`}
      className={[
        // Off-screen rather than hidden: still focusable, still announced.
        "absolute left-2 top-2 z-[100]",
        "-translate-y-[200%] focus:translate-y-0",
        "rounded-md border border-current/30 bg-background-base px-4 py-2",
        "text-sm font-medium text-midground no-underline",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-current",
        // The motion is a courtesy, not information; honour the preference.
        "motion-safe:transition-transform motion-safe:duration-150",
      ].join(" ")}
    >
      Skip to main content
    </a>
  );
}
