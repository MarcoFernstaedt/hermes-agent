/**
 * A dependency-free accessibility tripwire over rendered HTML.
 *
 * This is not a replacement for axe/NVDA (those run on-machine per release) — it
 * is the *automated author-time gate* that catches the highest-frequency,
 * unambiguous regressions in CI, on any surface we can render to a static HTML
 * string: an interactive element with no accessible name, or an image with no
 * alt. These are the failures that most break a screen reader, and they are
 * deterministic to detect. Kept tight on purpose: every rule here is
 * false-positive-free on well-formed React output, so it can gate the pipeline
 * without ever wrongly blocking a good change.
 */
export interface A11yFinding {
  rule: string;
  detail: string;
}

const VOID_IMG = /<img\b([^>]*)>/gi;
const OPEN_TAG = /<(button|a)\b([^>]*)>/gi;

function attr(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i"));
  return m ? m[1] : null;
}

function hasAccessibleNameAttr(attrs: string): boolean {
  return (
    !!attr(attrs, "aria-label")?.trim() ||
    !!attr(attrs, "aria-labelledby")?.trim() ||
    !!attr(attrs, "title")?.trim()
  );
}

/** Strip tags and collapse whitespace to approximate the accessible text. */
function visibleText(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Return accessibility findings for a fragment of rendered HTML. Empty ⇒ clean.
 *
 * Rules:
 *  - `interactive-name`: every <button>/<a> must have a non-empty accessible
 *    name — visible text, or an aria-label / aria-labelledby / title. Icon-only
 *    controls therefore must carry an aria-label (the codebase's own convention).
 *  - `img-alt`: every <img> must declare an `alt` attribute (`alt=""` is a valid
 *    decorative image and passes; a *missing* alt does not).
 */
export function auditA11y(html: string): A11yFinding[] {
  const findings: A11yFinding[] = [];

  // Images.
  for (const m of html.matchAll(VOID_IMG)) {
    const attrs = m[1] ?? "";
    if (!/\balt\s*=/.test(attrs)) {
      findings.push({ rule: "img-alt", detail: `<img> without alt: ${m[0].slice(0, 80)}` });
    }
  }

  // Interactive elements: pair each opening <button>/<a> with its matching close
  // to read the inner text. Nesting of these two tags does not occur in our
  // output, so a linear scan with a stack keyed by tag name is sufficient.
  for (const open of html.matchAll(OPEN_TAG)) {
    const tag = open[1].toLowerCase();
    const attrs = open[2] ?? "";
    // A link without href is not a control; skip (it's decorative text).
    if (tag === "a" && !/\bhref\s*=/.test(attrs)) continue;
    // aria-hidden interactive elements are removed from the a11y tree.
    if (/\baria-hidden\s*=\s*"true"/i.test(attrs)) continue;

    const start = (open.index ?? 0) + open[0].length;
    const close = html.indexOf(`</${tag}>`, start);
    const inner = close === -1 ? "" : html.slice(start, close);
    const name = visibleText(inner) || (hasAccessibleNameAttr(attrs) ? "x" : "");
    if (!name) {
      findings.push({
        rule: "interactive-name",
        detail: `<${tag}> with no accessible name: ${open[0].slice(0, 80)}`,
      });
    }
  }

  return findings;
}

export function isAccessible(html: string): boolean {
  return auditA11y(html).length === 0;
}

/**
 * Landmark and heading rules for a whole *page shell*, not a fragment.
 *
 * Separate from `auditA11y` on purpose: "exactly one h1" is a true statement
 * about a page and a false one about a card, so running these over a component
 * fragment would produce failures that mean nothing. Call this only on output
 * that represents a complete route.
 *
 * These three are the ones an NVDA user hits first and hardest:
 *
 *  - `skip-link`: the first focusable thing on the page must jump to the main
 *    content. Without it, reaching the page's actual content means tabbing
 *    through the entire navigation on every single route change.
 *  - `main-landmark`: exactly one `<main>`. Zero means the `M` shortcut and
 *    "skip to main" have nothing to land on; more than one means neither knows
 *    where to go.
 *  - `single-h1`: exactly one `<h1>`. The heading list is how a screen-reader
 *    user builds a mental map of a page, and two h1s describe two pages.
 */
export function auditPageShell(html: string): A11yFinding[] {
  const findings: A11yFinding[] = [...auditA11y(html)];

  const mains = html.match(/<main\b/gi) ?? [];
  if (mains.length !== 1) {
    findings.push({
      rule: "main-landmark",
      detail: `expected exactly one <main>, found ${mains.length}`,
    });
  }

  const h1s = html.match(/<h1\b/gi) ?? [];
  if (h1s.length !== 1) {
    findings.push({
      rule: "single-h1",
      detail: `expected exactly one <h1>, found ${h1s.length}`,
    });
  }

  // The skip link must target the main landmark's id, and must come before it
  // in source order — a skip link after the navigation it is meant to skip is
  // decoration.
  const skip = html.match(/<a\b[^>]*href\s*=\s*"#([^"]+)"[^>]*>/i);
  const mainId = html.match(/<main\b[^>]*\bid\s*=\s*"([^"]+)"/i);
  if (!skip || !mainId) {
    findings.push({
      rule: "skip-link",
      detail: !mainId
        ? "<main> has no id for a skip link to target"
        : "no in-page skip link found",
    });
  } else if (skip[1] !== mainId[1]) {
    findings.push({
      rule: "skip-link",
      detail: `skip link targets #${skip[1]} but <main> is #${mainId[1]}`,
    });
  } else if ((skip.index ?? 0) > (mainId.index ?? 0)) {
    findings.push({
      rule: "skip-link",
      detail: "the skip link comes after <main>, so it skips nothing",
    });
  }

  return findings;
}
