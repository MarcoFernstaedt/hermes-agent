import { describe, expect, it } from "vitest";

import {
  decideNavigation,
  makeReturnToken,
  refusalMessage,
  routeLabel,
  type NavigateContext,
  type NavigateIntent,
} from "./hubNavigate";

const ctx: NavigateContext = { isComposing: false, currentHref: "/jobs" };

function intent(over: Partial<NavigateIntent> = {}): NavigateIntent {
  return { route: "/review", reason: "You asked to see it.", ...over };
}

describe("decideNavigation", () => {
  it("allows an allow-listed route with a stated reason", () => {
    const d = decideNavigation(intent(), ctx);
    expect(d.allowed).toBe(true);
    expect(d.href).toBe("/review");
    expect(d.announcement).toContain("the review queue");
    expect(d.announcement).toContain("You asked to see it.");
  });

  it("refuses a route that is not on the list", () => {
    // The agent reads untrusted content; a navigation payload is an injection
    // target, so the frontend validates rather than executes.
    const d = decideNavigation(intent({ route: "/admin" }), ctx);
    expect(d.allowed).toBe(false);
    expect(d.refusal).toBe("route_not_allowed");
  });

  it.each([
    "https://evil.example/steal",
    "//evil.example",
    "javascript:alert(1)",
    "/review/../../etc/passwd",
  ])("refuses %s as a route", (route) => {
    expect(decideNavigation(intent({ route }), ctx).allowed).toBe(false);
  });

  it("refuses an unsafe entity id rather than encoding it", () => {
    for (const entityId of ["../secrets", "javascript:x", "a b", 'a"b', "//host"]) {
      const d = decideNavigation(intent({ entityId }), ctx);
      expect(d.allowed, entityId).toBe(false);
      expect(d.refusal).toBe("unsafe_target");
    }
  });

  it("refuses a move with no stated reason", () => {
    // An unexplained jump is indistinguishable from the app glitching.
    expect(decideNavigation(intent({ reason: "   " }), ctx).refusal).toBe("no_reason");
    expect(decideNavigation({ route: "/review" }, ctx).refusal).toBe("no_reason");
  });

  it("refuses an empty route", () => {
    expect(decideNavigation(intent({ route: "" }), ctx).refusal).toBe("route_missing");
  });

  it("builds the href from validated parts, never from raw input", () => {
    const d = decideNavigation(
      intent({ route: "/calendar", entityId: "evt-42", view: "week", range: "2026-07-29" }),
      ctx,
    );
    expect(d.href).toBe("/calendar/evt-42?view=week&range=2026-07-29");
  });

  it("percent-encodes an entity id that is safe but awkward", () => {
    const d = decideNavigation(intent({ route: "/vault", entityId: "note%2Fone" }), ctx);
    expect(d.allowed).toBe(true);
    expect(d.href).toContain("note%252Fone");
  });

  it("asks instead of moving when the owner is mid-composition", () => {
    // A navigation that eats a half-written message is worse than one that
    // never happens.
    const d = decideNavigation(intent(), { ...ctx, isComposing: true });
    expect(d.allowed).toBe(true);
    expect(d.needsConfirmation).toBe(true);
  });

  it("moves without asking when nothing is being typed", () => {
    expect(decideNavigation(intent(), ctx).needsConfirmation).toBe(false);
  });

  it("announces the destination before anything moves", () => {
    const d = decideNavigation(intent({ route: "/now", reason: "Two things need you." }), ctx);
    expect(d.announcement).toBe("Imperator is opening Now. Two things need you.");
  });

  it("refuses an over-long fragment", () => {
    const d = decideNavigation(intent({ entityId: "x".repeat(201) }), ctx);
    expect(d.refusal).toBe("unsafe_target");
  });
});

describe("makeReturnToken", () => {
  it("captures exactly where the owner was", () => {
    expect(makeReturnToken({ isComposing: false, currentHref: "/jobs?filter=open" })).toEqual({
      href: "/jobs?filter=open",
      label: "Back to where I was",
    });
  });
});

describe("refusalMessage", () => {
  it("explains every refusal in plain words", () => {
    for (const r of ["route_not_allowed", "route_missing", "unsafe_target", "no_reason"] as const) {
      const msg = refusalMessage(r);
      expect(msg.length).toBeGreaterThan(10);
      expect(msg).not.toContain("_");
    }
  });
});

describe("routeLabel", () => {
  it("reads naturally in a sentence", () => {
    expect(routeLabel("/review")).toBe("the review queue");
    expect(routeLabel("/now")).toBe("Now");
  });

  it("degrades gracefully for an unnamed route", () => {
    expect(routeLabel("/whatever")).toBe("whatever");
  });
});
