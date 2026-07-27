import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement as h } from "react";
import { auditA11y, isAccessible } from "./a11y-audit";

describe("auditA11y — catches real violations", () => {
  it("flags a button with no accessible name", () => {
    const f = auditA11y('<button class="x"><svg></svg></button>');
    expect(f.some((x) => x.rule === "interactive-name")).toBe(true);
  });

  it("flags an image with no alt", () => {
    expect(auditA11y('<img src="a.png">').some((x) => x.rule === "img-alt")).toBe(true);
  });

  it("flags an icon-link with no name", () => {
    const f = auditA11y('<a href="/x"><svg aria-hidden="true"></svg></a>');
    expect(f.some((x) => x.rule === "interactive-name")).toBe(true);
  });
});

describe("auditA11y — no false positives on good markup", () => {
  it("passes a button with visible text", () => {
    expect(isAccessible("<button>Save</button>")).toBe(true);
  });

  it("passes an icon-only button with aria-label", () => {
    expect(
      isAccessible('<button aria-label="Close"><svg aria-hidden="true"></svg></button>'),
    ).toBe(true);
  });

  it("passes an image with alt (including empty decorative alt)", () => {
    expect(isAccessible('<img src="a.png" alt="A cat">')).toBe(true);
    expect(isAccessible('<img src="d.png" alt="">')).toBe(true);
  });

  it("ignores an anchor without href (it is not a control)", () => {
    expect(isAccessible("<a>plain text span-like</a>")).toBe(true);
  });

  it("ignores an aria-hidden button", () => {
    expect(isAccessible('<button aria-hidden="true"></button>')).toBe(true);
  });
});

describe("auditA11y — over real rendered components", () => {
  // The renderer is the guarantee for every generated capability surface, so its
  // own accessible-name coverage must never regress. These render our building
  // blocks the way the fixed renderer does and assert zero findings.
  it("EmptyState-style content with a labelled action is clean", () => {
    const html = renderToStaticMarkup(
      h("div", null, [
        h("h2", { key: "t" }, "No records yet"),
        h("button", { key: "b" }, "New record"),
        h("img", { key: "i", src: "x.png", alt: "" }),
      ]),
    );
    expect(auditA11y(html)).toEqual([]);
  });

  it("a header with icon-only controls each carrying a label is clean", () => {
    const html = renderToStaticMarkup(
      h("header", null, [
        h("button", { key: "1", "aria-label": "Approve" }, h("span", { "aria-hidden": "true" }, "✓")),
        h("button", { key: "2", "aria-label": "Reject" }, h("span", { "aria-hidden": "true" }, "✕")),
      ]),
    );
    expect(auditA11y(html)).toEqual([]);
  });
});
