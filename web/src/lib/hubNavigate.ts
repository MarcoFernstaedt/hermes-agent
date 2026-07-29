/**
 * `hub_navigate` — the agent moves the app, within a fence.
 *
 * "Show me the Henderson deal" should take you there. What it must *not* become
 * is arbitrary frontend scripting driven by model output: the agent is exposed
 * to untrusted content (emails, web pages, news) and a navigation payload is an
 * obvious injection target. So the frontend never executes a route it was
 * handed — it validates an *intent* against an allow-list it owns, and refuses
 * anything not on it.
 *
 * Three further rules, all of which exist because navigation steals control
 * from whoever is currently using the app:
 *
 * - **Never move someone mid-typing.** A composing user gets asked, not moved.
 * - **Always announce the destination before focus moves**, or a screen-reader
 *   user finds themselves somewhere new with no idea why.
 * - **Always leave a way back**, for exactly one action.
 */

/** Routes the agent may send the owner to. Anything absent is refused. */
export const NAVIGABLE_ROUTES = [
  "/now",
  "/sessions",
  "/review",
  "/jobs",
  "/progress",
  "/email",
  "/calendar",
  "/vault",
  "/media",
  "/files",
  "/graph",
  "/search",
  "/capabilities",
  "/settings",
] as const;

export type NavigableRoute = (typeof NAVIGABLE_ROUTES)[number];

export interface NavigateIntent {
  route: string;
  /** Optional record to focus once the route is up. */
  entityId?: string;
  view?: string;
  filter?: string;
  range?: string;
  /** Why the agent is moving you. Shown, and announced. */
  reason?: string;
  sourceTurnId?: string;
}

export type NavigateRefusal =
  | "route_not_allowed"
  | "route_missing"
  | "unsafe_target"
  | "no_reason";

export interface NavigateDecision {
  allowed: boolean;
  refusal?: NavigateRefusal;
  /** The path to go to, built by *us* from validated parts — never from input. */
  href?: string;
  announcement?: string;
  /** True when the user is mid-composition and must be asked instead of moved. */
  needsConfirmation?: boolean;
}

/** Reject anything that could escape the SPA or smuggle a scheme. */
function isSafeFragment(value: string): boolean {
  if (!value) return true;
  if (value.length > 200) return false;
  // No protocol-relative or absolute URLs, no scheme, no path traversal, no
  // control characters or whitespace tricks.
  if (/^\/\//.test(value)) return false;
  if (/[a-z][a-z0-9+.-]*:/i.test(value)) return false;
  if (value.includes("..")) return false;
  return !/[\s<>"'`\\]/.test(value);
}

export interface NavigateContext {
  /** The owner is typing or has an IME composition open. */
  isComposing: boolean;
  /** Where they are now, captured so "back to where I was" can return. */
  currentHref: string;
}

/**
 * Validate an agent-proposed navigation.
 *
 * Returns a decision rather than throwing: a refused navigation is an ordinary
 * outcome the UI should report quietly, not an exception that breaks a turn.
 */
export function decideNavigation(
  intent: NavigateIntent,
  context: NavigateContext,
): NavigateDecision {
  const route = (intent.route || "").trim();
  if (!route) return { allowed: false, refusal: "route_missing" };

  if (!(NAVIGABLE_ROUTES as readonly string[]).includes(route)) {
    return { allowed: false, refusal: "route_not_allowed" };
  }

  for (const value of [intent.entityId, intent.view, intent.filter, intent.range]) {
    if (value !== undefined && !isSafeFragment(value)) {
      return { allowed: false, refusal: "unsafe_target" };
    }
  }

  // A move with no stated reason is indistinguishable from the app glitching.
  const reason = (intent.reason || "").trim();
  if (!reason) return { allowed: false, refusal: "no_reason" };

  // Built from validated parts. The input string is never used as a URL.
  const params = new URLSearchParams();
  if (intent.view) params.set("view", intent.view);
  if (intent.filter) params.set("filter", intent.filter);
  if (intent.range) params.set("range", intent.range);
  const query = params.toString();
  const href =
    route +
    (intent.entityId ? `/${encodeURIComponent(intent.entityId)}` : "") +
    (query ? `?${query}` : "");

  return {
    allowed: true,
    href,
    announcement: `Imperator is opening ${routeLabel(route)}. ${reason}`,
    // Asked, not moved — a navigation that eats a half-written message is worse
    // than one that never happens.
    needsConfirmation: context.isComposing,
  };
}

export function routeLabel(route: string): string {
  const named: Record<string, string> = {
    "/now": "Now",
    "/sessions": "Sessions",
    "/review": "the review queue",
    "/jobs": "Jobs",
    "/progress": "Progress",
    "/email": "Email",
    "/calendar": "Calendar",
    "/vault": "the vault",
    "/media": "Media",
    "/files": "Files",
    "/graph": "the graph",
    "/search": "Search",
    "/capabilities": "Capabilities",
    "/settings": "Settings",
  };
  return named[route] ?? route.replace(/^\//, "");
}

/**
 * The one-step return token.
 *
 * Deliberately holds exactly one entry rather than a stack: "back to where I
 * was" means the place the agent took you from, and a growing history would
 * turn one affordance into a second browser.
 */
export function makeReturnToken(context: NavigateContext): { href: string; label: string } {
  return { href: context.currentHref, label: "Back to where I was" };
}

export function refusalMessage(refusal: NavigateRefusal): string {
  switch (refusal) {
    case "route_not_allowed":
      return "That destination is not one Imperator may open.";
    case "route_missing":
      return "No destination was given.";
    case "unsafe_target":
      return "That destination looked unsafe and was not opened.";
    case "no_reason":
      return "Imperator did not say why it wanted to move you.";
  }
}
