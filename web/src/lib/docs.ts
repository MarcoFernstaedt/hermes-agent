/**
 * In-app documentation model.
 *
 * The full manual ships with the dashboard: every markdown page under
 * `website/docs` is indexed at build time by
 * `scripts/generate-docs-manifest.mjs` (nav tree + titles) and the page
 * bodies are pulled in as lazy raw-text chunks via `import.meta.glob`,
 * so a doc costs nothing until it is opened.
 *
 * Doc prose is written against the upstream "Hermes" name; rendering
 * rebrands display text to Imperator. Code blocks, inline code, env keys,
 * and literal CLI commands are left untouched (the transform runs on
 * prose nodes only — see Markdown's `transformText`).
 */
import manifestJson from "@/generated/docs-manifest.json";
import { imperatorBrand } from "@/lib/imperator-branding";

export interface DocLeaf {
  kind: "doc";
  /** Page id: docs-root-relative path without extension. */
  page: string;
  slug: string;
  title: string;
}

export interface DocGroup {
  kind: "group";
  slug: string;
  label: string;
  children: DocNode[];
}

export type DocNode = DocLeaf | DocGroup;

export interface DocSection {
  id: string;
  label: string;
  children: DocNode[];
}

export const DOCS_MANIFEST = manifestJson as DocSection[];

/** Raw markdown loaders, keyed by page id. Chunks load on demand. */
const RAW_MODULES = import.meta.glob("../../../website/docs/**/*.md", {
  query: "?raw",
  import: "default",
}) as Record<string, () => Promise<string>>;

const PAGE_LOADERS = new Map<string, () => Promise<string>>();
for (const [modulePath, loader] of Object.entries(RAW_MODULES)) {
  const page = modulePath
    .replace(/^.*?\/website\/docs\//, "")
    .replace(/\.md$/, "");
  PAGE_LOADERS.set(page, loader);
}

export function hasDocPage(page: string): boolean {
  return PAGE_LOADERS.has(page);
}

export function loadDocPage(page: string): Promise<string> | null {
  const loader = PAGE_LOADERS.get(page);
  return loader ? loader() : null;
}

/** Flattened reading order (for prev/next and search). */
export interface FlatDoc {
  page: string;
  title: string;
  /** e.g. "User guide › Features" */
  trail: string;
}

function flattenNodes(nodes: DocNode[], trail: string, out: FlatDoc[]) {
  for (const node of nodes) {
    if (node.kind === "doc") {
      out.push({ page: node.page, title: node.title, trail });
    } else {
      flattenNodes(node.children, `${trail} › ${node.label}`, out);
    }
  }
}

let flatCache: FlatDoc[] | null = null;
export function flattenDocs(): FlatDoc[] {
  if (!flatCache) {
    flatCache = [];
    for (const section of DOCS_MANIFEST) {
      flattenNodes(section.children, section.label, flatCache);
    }
  }
  return flatCache;
}

export function docTitle(page: string): string | null {
  return flattenDocs().find((d) => d.page === page)?.title ?? null;
}

/** Display-level rebrand for doc prose (never applied to code). */
export function imperatorDocText(text: string): string {
  return imperatorBrand(text)
    // Keep the Nous Portal product name; rebrand the company name.
    .replace(/Nous Research/g, "Imperator Systems")
    .replace(/(?<![A-Za-z0-9_$])hermes-agent(?![A-Za-z0-9_$-])/g, "imperator-agent");
}

const ADMONITION_LABELS: Record<string, string> = {
  note: "Note",
  tip: "Tip",
  info: "Info",
  warning: "Warning",
  caution: "Caution",
  danger: "Danger",
  important: "Important",
};

/**
 * Convert the Docusaurus-flavored source into the plain markdown dialect
 * the in-app renderer understands: strip frontmatter/imports/JSX chrome,
 * turn admonitions into blockquotes, drop images (no static asset host),
 * and rewrite internal doc links onto the in-app /docs route.
 */
export function preprocessDoc(raw: string, page: string): string {
  let text = raw;

  // Frontmatter.
  text = text.replace(/^---\n[\s\S]*?\n---\n?/, "");

  const lines = text.split("\n");
  const out: string[] = [];
  let admonitionDepth = 0;
  let inFence = false;
  /** Closing tag that ends a raw HTML/JSX block being skipped. */
  let skipUntilClose: string | null = null;

  for (let line of lines) {
    if (/^```/.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }

    // Multi-line raw HTML/JSX blocks (video embeds, badge rows…) have no
    // in-app rendering — skip them wholesale.
    if (skipUntilClose) {
      if (line.includes(skipUntilClose)) skipUntilClose = null;
      continue;
    }

    // MDX imports / comments.
    if (/^import\s.+from\s+['"].+['"];?\s*$/.test(line)) continue;
    if (/^\s*\{\/\*.*\*\/\}\s*$/.test(line)) continue;

    // Admonitions -> blockquotes.
    const open = line.match(/^:::(\w+)\s*(.*)$/);
    if (open) {
      const word = open[1].toLowerCase();
      const label =
        ADMONITION_LABELS[word] ??
        word.charAt(0).toUpperCase() + word.slice(1);
      admonitionDepth++;
      out.push(`> **${label}${open[2] ? `: ${open[2]}` : ""}**`);
      out.push(">");
      continue;
    }
    if (/^:::\s*$/.test(line)) {
      if (admonitionDepth > 0) admonitionDepth--;
      continue;
    }
    if (admonitionDepth > 0) {
      out.push(line.trim() === "" ? ">" : `> ${line}`);
      continue;
    }

    // <details>/<summary> and capitalized JSX component tags.
    const summary = line.match(/^\s*<summary>(.*)<\/summary>\s*$/);
    if (summary) {
      out.push(`**${summary[1]}**`);
      continue;
    }
    if (/^\s*<\/?(details|Tabs|TabItem|Columns|Column|CodeBlock)\b[^>]*>\s*$/.test(line)) {
      continue;
    }
    // Any other block-level raw HTML/JSX (e.g. a <div …> video embed):
    // drop the whole element. Autolinks (<https://…>) and inline HTML in
    // prose don't start the line with a bare tag, so they pass through.
    const rawTag = line.match(/^\s*<([a-zA-Z][\w-]*)(\s|>|$)/);
    if (rawTag && !/^\s*<(https?:|kbd|br|hr)\b/i.test(line)) {
      const closing = `</${rawTag[1]}>`;
      if (!line.includes(closing) && !/\/>\s*$/.test(line)) {
        skipUntilClose = closing;
      }
      continue;
    }

    // Images -> italic alt text (static assets aren't bundled).
    line = line.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, alt: string) =>
      alt ? `*${alt}*` : "",
    );

    out.push(line);
  }
  text = out.join("\n");

  // Rewrite internal links onto the in-app route. External http(s) and
  // mailto links pass through untouched.
  const dir = page.includes("/") ? page.slice(0, page.lastIndexOf("/")) : "";
  text = text.replace(
    /\]\(([^)\s]+)\)/g,
    (match, target: string) => {
      if (/^(https?:|mailto:|#)/i.test(target)) return match;
      const [path] = target.split("#");
      let resolved: string | null = null;
      if (path.startsWith("/docs/")) {
        resolved = path.slice("/docs/".length);
      } else if (!path.startsWith("/")) {
        // Relative to the current page's directory.
        const stack = dir ? dir.split("/") : [];
        for (const part of path.split("/")) {
          if (part === "." || part === "") continue;
          else if (part === "..") stack.pop();
          else stack.push(part);
        }
        resolved = stack.join("/");
      }
      if (resolved === null) return match;
      resolved = resolved.replace(/\.mdx?$/, "").replace(/\/$/, "");
      const candidates = [resolved, `${resolved}/index`];
      for (const candidate of candidates) {
        if (hasDocPage(candidate)) {
          return `](/docs?page=${encodeURIComponent(candidate)})`;
        }
      }
      return match;
    },
  );

  return text;
}
