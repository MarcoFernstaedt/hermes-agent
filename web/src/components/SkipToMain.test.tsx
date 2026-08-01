/**
 * The skip link and the main landmark.
 *
 * These are release-blocking for an NVDA user and neither existed in the
 * audited release. Without them, reaching a page's actual content means
 * tabbing the whole sidebar on every route change, and the `M` landmark
 * shortcut has nothing to land on.
 *
 * The tests assert the properties that make it *work*, not that the component
 * renders: still focusable, first in order, targeting a real landmark that can
 * accept focus.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { auditPageShell } from "@/lib/a11y-audit";
import { SkipToMain } from "./SkipToMain";

const link = () => renderToStaticMarkup(<SkipToMain />);

describe("the skip link", () => {
  it("is a real in-page anchor, not a scroll button", () => {
    // The browser's own fragment navigation moves *focus*, which is what a
    // screen reader follows. A click handler that scrolls does not.
    expect(link()).toMatch(/<a\b[^>]*href="#main-content"/);
  });

  it("names its destination in words", () => {
    expect(link()).toContain("Skip to main content");
  });

  it("is hidden off-screen rather than removed from the tab order", () => {
    // display:none or visibility:hidden would take it out of the tab order,
    // which is the entire mechanism.
    const html = link();
    expect(html).not.toMatch(/\bhidden\b/);
    expect(html).not.toMatch(/display:\s*none/);
    expect(html).toMatch(/-translate-y-\[200%\]/);
    expect(html).toMatch(/focus:translate-y-0/);
  });

  it("keeps a visible focus indicator", () => {
    expect(link()).toMatch(/focus-visible:ring/);
  });

  it("only animates when motion is welcome", () => {
    expect(link()).toMatch(/motion-safe:transition/);
  });

  it("can target a different landmark id when a surface needs one", () => {
    const html = renderToStaticMarkup(<SkipToMain targetId="other-main" />);
    expect(html).toMatch(/href="#other-main"/);
  });
});

/**
 * A stand-in for the app shell's structure. Not the real `App` — that pulls a
 * router, a media provider, plugins and a websocket — but the *shape* the
 * shell renders, so the landmark rules are exercised against the arrangement
 * that ships rather than against a description of it.
 */
function shell({
  skip = true,
  mainId = "main-content",
  h1s = 1,
  skipFirst = true,
}: {
  skip?: boolean;
  mainId?: string;
  h1s?: number;
  skipFirst?: boolean;
} = {}) {
  const skipLink = skip ? <SkipToMain targetId={mainId} /> : null;
  return renderToStaticMarkup(
    <div>
      {skipFirst ? skipLink : null}
      <nav aria-label="Primary">
        <a href="/now">Now</a>
      </nav>
      <main id={mainId} tabIndex={-1}>
        {Array.from({ length: h1s }, (_, i) => (
          <h1 key={i}>Now</h1>
        ))}
        <p>Content</p>
      </main>
      {skipFirst ? null : skipLink}
    </div>,
  );
}

describe("page shell landmarks", () => {
  it("passes with one main, one h1, and a skip link that comes first", () => {
    expect(auditPageShell(shell())).toEqual([]);
  });

  it("fails when there is no skip link", () => {
    const rules = auditPageShell(shell({ skip: false })).map((f) => f.rule);
    expect(rules).toContain("skip-link");
  });

  it("fails when the skip link comes after the content it should skip", () => {
    // A skip link at the end of the page is decoration: Tab reaches it only
    // after passing everything it was meant to bypass.
    const findings = auditPageShell(shell({ skipFirst: false }));
    expect(findings.map((f) => f.rule)).toContain("skip-link");
    expect(findings[0].detail).toMatch(/skips nothing/);
  });

  it("fails when the skip link points at nothing", () => {
    const html = renderToStaticMarkup(
      <div>
        <SkipToMain targetId="does-not-exist" />
        <main id="main-content" tabIndex={-1}>
          <h1>Now</h1>
        </main>
      </div>,
    );
    const findings = auditPageShell(html);
    expect(findings.map((f) => f.rule)).toContain("skip-link");
    expect(findings[0].detail).toMatch(/#does-not-exist/);
  });

  it("fails on two h1s, because two h1s describe two pages", () => {
    expect(auditPageShell(shell({ h1s: 2 })).map((f) => f.rule)).toContain("single-h1");
  });

  it("fails on no h1 at all", () => {
    expect(auditPageShell(shell({ h1s: 0 })).map((f) => f.rule)).toContain("single-h1");
  });

  it("fails on a second main, because neither knows where to send focus", () => {
    const html = renderToStaticMarkup(
      <div>
        <SkipToMain />
        <main id="main-content">
          <h1>Now</h1>
        </main>
        <main>
          <p>Another</p>
        </main>
      </div>,
    );
    expect(auditPageShell(html).map((f) => f.rule)).toContain("main-landmark");
  });

  it("still applies the fragment-level rules it inherits", () => {
    // A shell audit must not be a weaker audit.
    const html = renderToStaticMarkup(
      <div>
        <SkipToMain />
        <main id="main-content">
          <h1>Now</h1>
          <button type="button" />
        </main>
      </div>,
    );
    expect(auditPageShell(html).map((f) => f.rule)).toContain("interactive-name");
  });
});
