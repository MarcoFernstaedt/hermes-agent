/**
 * Quick chat — the same conversation, in a different frame.
 *
 * The brief's hard requirement is that the overlay is *the same session* as the
 * full feed, not a parallel one: "Imperator does not forget what you said in
 * the hallway." The tempting implementation — mount a second, smaller chat —
 * fails that immediately and subtly, because two mounts mean two sessions, two
 * queues, and two transcripts that drift.
 *
 * So there is no second chat. `ChatPage` is already mounted persistently by the
 * shell and merely hidden when you are not on `/chat`. Quick chat is a third
 * *presentation* of that one instance: full page, floating overlay, or hidden.
 * Sameness is then structural rather than promised — there is only one thing to
 * be the same as.
 *
 * This module is the pure half: which presentation applies, how focus is
 * returned, and how the state survives the URL.
 */

export type ChatPresentation = "full" | "overlay" | "hidden";

/**
 * Where chat should render right now.
 *
 * On `/chat` the overlay is redundant and would be a second frame around the
 * same thing, so the full page always wins. That also means opening quick chat
 * and then navigating to `/chat` promotes rather than duplicates — the
 * "promote to the full feed without losing the thread" requirement falls out of
 * the same rule instead of needing its own handoff.
 */
export function chatPresentation(pathname: string, quickOpen: boolean): ChatPresentation {
  if (isChatRoute(pathname)) return "full";
  return quickOpen ? "overlay" : "hidden";
}

export function isChatRoute(pathname: string): boolean {
  return pathname === "/chat" || pathname.startsWith("/chat/");
}

/** The overlay is addressable, so back and deep links behave. */
export const QUICK_CHAT_PARAM = "chat";
export const QUICK_CHAT_VALUE = "quick";

export function quickOpenFromSearch(search: string): boolean {
  return new URLSearchParams(search).get(QUICK_CHAT_PARAM) === QUICK_CHAT_VALUE;
}

/** Build the search string for a given open/closed state, preserving the rest. */
export function searchWithQuickChat(search: string, open: boolean): string {
  const params = new URLSearchParams(search);
  if (open) params.set(QUICK_CHAT_PARAM, QUICK_CHAT_VALUE);
  else params.delete(QUICK_CHAT_PARAM);
  const next = params.toString();
  return next ? `?${next}` : "";
}

/**
 * Does this keystroke open quick chat?
 *
 * Deliberately ignores keystrokes aimed at a text field. A shortcut that fires
 * while someone is typing into a search box is a shortcut that eats their
 * input, and the whole promise here is that the current surface survives.
 */
export interface KeyLike {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

export interface OpenShortcut {
  key: string;
  /** Meta on macOS, Control elsewhere — resolved by the caller. */
  withModifier: boolean;
}

export const DEFAULT_OPEN_SHORTCUT: OpenShortcut = { key: "j", withModifier: true };

export function matchesOpenShortcut(
  event: KeyLike,
  shortcut: OpenShortcut = DEFAULT_OPEN_SHORTCUT,
): boolean {
  if (event.key.toLowerCase() !== shortcut.key.toLowerCase()) return false;
  if (event.altKey) return false;
  const modifier = Boolean(event.metaKey || event.ctrlKey);
  return shortcut.withModifier ? modifier : !modifier;
}

/**
 * Whether a keystroke should be ignored because the owner is typing.
 *
 * `isContentEditable` covers rich editors; the tag check covers the ordinary
 * cases. A `null` target (synthetic events, tests) is treated as not-typing.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as (HTMLElement & { isContentEditable?: boolean }) | null;
  if (!el || typeof el.tagName !== "string") return false;
  if (el.isContentEditable) return true;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName.toUpperCase());
}

/**
 * Focus restoration.
 *
 * Escape must return focus *exactly* where it was, not merely to the document
 * body — for a keyboard or screen-reader user, landing at the top of the page
 * after closing an overlay means re-navigating everything they had already
 * traversed.
 */
export interface FocusToken {
  element: HTMLElement | null;
  /** Where the page was scrolled, so closing does not also lose their place. */
  scrollY: number;
}

export function captureFocus(doc: Document = document, win: Window = window): FocusToken {
  const active = doc.activeElement;
  return {
    element:
      active instanceof HTMLElement && active !== doc.body ? active : null,
    scrollY: win.scrollY,
  };
}

/** Not every host implements scrollTo (jsdom, some embedded webviews). */
function scrollBackTo(win: Window, top: number): void {
  try {
    win.scrollTo?.({ top });
  } catch {
    /* restoring focus matters more than restoring scroll */
  }
}

export function restoreFocus(token: FocusToken | null, win: Window = window): boolean {
  if (!token) return false;
  const el = token.element;
  // A node that left the DOM while the overlay was open cannot be focused, and
  // trying would throw or silently move focus somewhere arbitrary.
  if (!el || !el.isConnected) {
    scrollBackTo(win, token.scrollY);
    return false;
  }
  try {
    el.focus({ preventScroll: true });
    scrollBackTo(win, token.scrollY);
    return true;
  } catch {
    return false;
  }
}
