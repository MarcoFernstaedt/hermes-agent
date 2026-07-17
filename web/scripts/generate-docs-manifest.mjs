#!/usr/bin/env node
/**
 * Generates src/generated/docs-manifest.json from the documentation
 * source in ../website/docs so the dashboard can serve the full manual
 * in-app (see src/pages/DocsPage.tsx). Run manually after editing docs:
 *
 *   node scripts/generate-docs-manifest.mjs
 *
 * Only .md files are indexed — the three .mdx pages are JSX-driven
 * marketing/landing layouts that don't translate to the in-app renderer.
 */
import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS_ROOT = resolve(HERE, "../../website/docs");
const OUT_FILE = resolve(HERE, "../src/generated/docs-manifest.json");

/** Top-level section order + display labels. */
const SECTIONS = [
  ["getting-started", "Getting started"],
  ["user-guide", "User guide"],
  ["guides", "Guides"],
  ["integrations", "Integrations"],
  ["reference", "Reference"],
  ["developer-guide", "Developer guide"],
];

/** Directory labels that shouldn't be naive Title Case. */
const DIR_LABELS = {
  mcp: "MCP",
  acp: "ACP",
  mlops: "MLOps",
  faq: "FAQ",
  tui: "TUI",
  cli: "CLI",
  "smart-home": "Smart home",
  "note-taking": "Note taking",
  "data-science": "Data science",
  "social-media": "Social media",
  "web-development": "Web development",
  "software-development": "Software development",
  "autonomous-ai-agents": "Autonomous AI agents",
  devops: "DevOps",
  osint: "OSINT",
};

function titleCase(slug) {
  if (DIR_LABELS[slug]) return DIR_LABELS[slug];
  return slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function parseFrontmatter(raw) {
  const meta = { title: null, position: null };
  if (!raw.startsWith("---")) return meta;
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return meta;
  for (const line of raw.slice(3, end).split("\n")) {
    const m = line.match(/^(title|sidebar_label|sidebar_position):\s*(.+)\s*$/);
    if (!m) continue;
    const value = m[2].replace(/^["']|["']$/g, "").trim();
    if (m[1] === "sidebar_position") {
      const n = Number(value);
      if (Number.isFinite(n)) meta.position = n;
    } else if (m[1] === "sidebar_label" || meta.title === null) {
      // sidebar_label wins over title for nav purposes.
      meta.title = value;
    }
  }
  return meta;
}

function docTitle(raw, slug) {
  const meta = parseFrontmatter(raw);
  if (meta.title) return { title: meta.title, position: meta.position };
  const heading = raw.replace(/^---[\s\S]*?\n---\n?/, "").match(/^#\s+(.+)$/m);
  return {
    title: heading ? heading[1].replace(/[*_`]/g, "").trim() : titleCase(slug),
    position: meta.position,
  };
}

function walk(dir) {
  const nodes = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      const children = walk(full);
      if (children.length) {
        nodes.push({
          kind: "group",
          slug: entry,
          label: titleCase(entry),
          children,
        });
      }
      continue;
    }
    if (!entry.endsWith(".md")) continue;
    const raw = readFileSync(full, "utf8");
    const slug = entry.replace(/\.md$/, "");
    const { title, position } = docTitle(raw, slug);
    nodes.push({
      kind: "doc",
      // Path relative to the docs root, no extension — the page id.
      page: relative(DOCS_ROOT, full).replace(/\.md$/, ""),
      slug,
      title,
      position,
    });
  }
  // index pages first, then explicit positions, then alphabetical.
  nodes.sort((a, b) => {
    const rank = (n) =>
      n.kind === "doc" && n.slug === "index"
        ? -1
        : (n.position ?? Number.MAX_SAFE_INTEGER);
    const d = rank(a) - rank(b);
    if (d !== 0) return d;
    return (a.title ?? a.label).localeCompare(b.title ?? b.label);
  });
  return nodes.map(({ position: _position, ...node }) => node);
}

const sections = [];
for (const [id, label] of SECTIONS) {
  const dir = join(DOCS_ROOT, id);
  let children;
  try {
    children = walk(dir);
  } catch {
    continue;
  }
  if (children.length) sections.push({ id, label, children });
}

mkdirSync(dirname(OUT_FILE), { recursive: true });
writeFileSync(OUT_FILE, `${JSON.stringify(sections, null, 1)}\n`);
const count = JSON.stringify(sections).match(/"kind":"doc"/g)?.length ?? 0;
console.log(`docs-manifest: ${sections.length} sections, ${count} pages -> ${relative(process.cwd(), OUT_FILE)}`);
