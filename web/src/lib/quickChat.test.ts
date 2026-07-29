// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import {
  captureFocus,
  chatPresentation,
  isChatRoute,
  isTypingTarget,
  matchesOpenShortcut,
  quickOpenFromSearch,
  restoreFocus,
  searchWithQuickChat,
} from "./quickChat";

describe("chatPresentation", () => {
  it("is one instance in three frames, never two chats", () => {
    expect(chatPresentation("/jobs", false)).toBe("hidden");
    expect(chatPresentation("/jobs", true)).toBe("overlay");
    expect(chatPresentation("/chat", false)).toBe("full");
  });

  it("promotes rather than duplicating when you reach the chat route", () => {
    // Opening the overlay and then navigating to /chat must not leave a
    // floating copy over the page it was promoted into.
    expect(chatPresentation("/chat", true)).toBe("full");
  });

  it("treats chat sub-routes as the full page", () => {
    expect(chatPresentation("/chat/abc123", true)).toBe("full");
    expect(isChatRoute("/chat/abc123")).toBe(true);
  });

  it("does not mistake a lookalike route for chat", () => {
    expect(isChatRoute("/chatter")).toBe(false);
    expect(chatPresentation("/chatter", true)).toBe("overlay");
  });
});

describe("route addressability", () => {
  it("reads the overlay state out of the URL", () => {
    expect(quickOpenFromSearch("?chat=quick")).toBe(true);
    expect(quickOpenFromSearch("?chat=nope")).toBe(false);
    expect(quickOpenFromSearch("")).toBe(false);
  });

  it("preserves the rest of the query when opening and closing", () => {
    expect(searchWithQuickChat("?filter=open&page=2", true)).toBe(
      "?filter=open&page=2&chat=quick",
    );
    expect(searchWithQuickChat("?filter=open&chat=quick", false)).toBe("?filter=open");
  });

  it("produces an empty string rather than a bare question mark", () => {
    expect(searchWithQuickChat("?chat=quick", false)).toBe("");
  });

  it("round-trips", () => {
    const opened = searchWithQuickChat("?a=1", true);
    expect(quickOpenFromSearch(opened)).toBe(true);
    expect(quickOpenFromSearch(searchWithQuickChat(opened, false))).toBe(false);
  });
});

describe("matchesOpenShortcut", () => {
  it("fires on the modifier combination", () => {
    expect(matchesOpenShortcut({ key: "j", metaKey: true })).toBe(true);
    expect(matchesOpenShortcut({ key: "J", ctrlKey: true })).toBe(true);
  });

  it("ignores the bare key", () => {
    expect(matchesOpenShortcut({ key: "j" })).toBe(false);
  });

  it("ignores a different key", () => {
    expect(matchesOpenShortcut({ key: "k", metaKey: true })).toBe(false);
  });

  it("does not fire when Alt is held", () => {
    // Alt+Cmd+J is somebody else's shortcut; claiming it would be rude.
    expect(matchesOpenShortcut({ key: "j", metaKey: true, altKey: true })).toBe(false);
  });

  it("supports a configured non-modifier shortcut", () => {
    const shortcut = { key: "/", withModifier: false };
    expect(matchesOpenShortcut({ key: "/" }, shortcut)).toBe(true);
    expect(matchesOpenShortcut({ key: "/", metaKey: true }, shortcut)).toBe(false);
  });
});

describe("isTypingTarget", () => {
  it("recognises the ordinary form fields", () => {
    for (const tag of ["input", "textarea", "select"]) {
      expect(isTypingTarget(document.createElement(tag)), tag).toBe(true);
    }
  });

  it("recognises a rich editor", () => {
    const div = document.createElement("div");
    div.contentEditable = "true";
    // jsdom does not implement isContentEditable, so set it directly.
    Object.defineProperty(div, "isContentEditable", { value: true });
    expect(isTypingTarget(div)).toBe(true);
  });

  it("lets the shortcut through from ordinary elements", () => {
    expect(isTypingTarget(document.createElement("div"))).toBe(false);
    expect(isTypingTarget(document.createElement("button"))).toBe(false);
  });

  it("treats a missing target as not typing", () => {
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe("focus restoration", () => {
  it("returns focus to the exact element, not the body", () => {
    // Landing on the body means a keyboard user re-traverses everything they
    // had already got through.
    const button = document.createElement("button");
    document.body.appendChild(button);
    button.focus();

    const token = captureFocus();
    expect(token.element).toBe(button);

    (document.activeElement as HTMLElement | null)?.blur();
    expect(restoreFocus(token)).toBe(true);
    expect(document.activeElement).toBe(button);

    button.remove();
  });

  it("records nothing when focus was on the body", () => {
    (document.activeElement as HTMLElement | null)?.blur();
    expect(captureFocus().element).toBeNull();
  });

  it("survives the focused element being removed while the overlay was open", () => {
    const button = document.createElement("button");
    document.body.appendChild(button);
    button.focus();
    const token = captureFocus();

    button.remove();
    // Reports failure rather than throwing or dumping focus somewhere random.
    expect(restoreFocus(token)).toBe(false);
  });

  it("restores scroll position alongside focus", () => {
    const token = { element: null, scrollY: 420 };
    let scrolledTo = -1;
    const win = {
      scrollTo: (opts: { top: number }) => {
        scrolledTo = opts.top;
      },
    } as unknown as Window;
    restoreFocus(token, win);
    expect(scrolledTo).toBe(420);
  });

  it("handles a null token without throwing", () => {
    expect(restoreFocus(null)).toBe(false);
  });
});
