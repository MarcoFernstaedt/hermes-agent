/**
 * Landmark rules against the **real** shell, not a stand-in.
 *
 * The previous version of this check rendered a hand-written approximation of
 * the shell and passed while the shipped application had three `<main>`
 * elements: one in `PageHeaderProvider`, one I added in `App.tsx`, and one per
 * page in `VaultPage` and `ThreePane`. The stand-in agreed with my assumption
 * and the assumption was wrong — the same failure mode as every fixture defect
 * this project has hit.
 *
 * So these render the actual components. `PageHeaderProvider` is the one that
 * owns the landmark, and the page-level blocks are rendered inside it exactly
 * as the router does, so a second `<main>` reintroduced anywhere in that tree
 * fails here.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { SkipToMain } from "@/components/SkipToMain";
import { PageHeaderProvider } from "@/contexts/PageHeaderProvider";
import { ThreePane } from "@/blocks/ThreePane";
import { auditPageShell } from "@/lib/a11y-audit";

/** The real provider, at a real route, wrapping whatever a page renders. */
function shell(children: React.ReactNode, { route = "/now" } = {}) {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[route]}>
      <div>
        <SkipToMain />
        <nav aria-label="Primary">
          <a href="/now">Now</a>
        </nav>
        <PageHeaderProvider pluginTabs={[]}>{children}</PageHeaderProvider>
      </div>
    </MemoryRouter>,
  );
}

function countMains(html: string): number {
  return (html.match(/<main\b/gi) ?? []).length;
}

/**
 * The provider owns the page `h1` — it renders the page title. Pages therefore
 * contribute `h2` and below. Rendering the real shell is what surfaced this:
 * eleven components were shipping their own `h1` under a provider that already
 * had one, so every one of those routes announced two page titles.
 */
describe("the provider owns the only h1", () => {
  it("renders one h1 for a page that adds none", () => {
    const html = shell(<p>Content</p>);
    expect((html.match(/<h1\b/gi) ?? []).length).toBe(1);
    expect(auditPageShell(html)).toEqual([]);
  });

  it("fails when a page adds its own", () => {
    const findings = auditPageShell(shell(<h1>Now</h1>));
    expect(findings.map((f) => f.rule)).toContain("single-h1");
  });
});

describe("the real shell has exactly one main", () => {
  it("renders one landmark with an empty page", () => {
    expect(countMains(shell(<p>Content</p>))).toBe(1);
  });

  it("gives that landmark the id the skip link targets", () => {
    // The regression: `App.tsx` added its own `<main id="main-content">`
    // *around* this one, so the id existed twice and the skip link had two
    // destinations.
    const html = shell(<h1>Now</h1>);
    expect(html).toMatch(/<main[^>]*id="main-content"/);
    expect((html.match(/id="main-content"/g) ?? []).length).toBe(1);
  });

  it("makes the landmark focusable, so the skip link moves focus", () => {
    // Without tabIndex the browser scrolls and leaves focus in the navigation,
    // so the next Tab returns to what the user was escaping.
    expect(shell(<h1>Now</h1>)).toMatch(/<main[^>]*tabindex="-1"/i);
  });

  it("passes the whole shell audit", () => {
    expect(auditPageShell(shell(<p>Content</p>))).toEqual([]);
  });
});

describe("page-level blocks do not add landmarks", () => {
  it("ThreePane renders a labelled region, not a second main", () => {
    // It rendered a `<main>` before: a detail pane competing with the page.
    const html = shell(
      <>
        <h1>Sessions</h1>
        <ThreePane list={<p>list</p>} detail={<p>detail</p>} />
      </>,
    );
    expect(countMains(html)).toBe(1);
    expect(html).toMatch(/<section[^>]*aria-label="Detail"/);
  });

  it("still fails loudly if a page reintroduces one", () => {
    // The guard has to be able to fail, or it proves nothing.
    const html = shell(
      <>
        <h1>Now</h1>
        <main>a second landmark</main>
      </>,
    );
    expect(countMains(html)).toBe(2);
    expect(auditPageShell(html).map((f) => f.rule)).toContain("main-landmark");
  });
});

describe("the skip link still comes first", () => {
  it("precedes the navigation and the landmark in DOM order", () => {
    const html = shell(<h1>Now</h1>);
    const skip = html.indexOf('href="#main-content"');
    const nav = html.indexOf("<nav");
    const main = html.indexOf("<main");
    expect(skip).toBeGreaterThanOrEqual(0);
    expect(skip).toBeLessThan(nav);
    expect(skip).toBeLessThan(main);
  });
});
