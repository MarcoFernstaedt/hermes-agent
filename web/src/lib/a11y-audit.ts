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
