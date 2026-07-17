/**
 * Display-level rebrand for backend-supplied copy (skill/plugin/channel/
 * config/env descriptions arrive from the Python side still saying
 * "Hermes"). Case-sensitive word replace so lowercase CLI commands
 * (`hermes update`, `hermes plugins enable …`), env keys (HERMES_*), and
 * identifiers pass through untouched.
 */
export function imperatorBrand(text: string): string {
  return text
    .replace(/(?<![A-Za-z0-9_$])Hermes Agent(?![A-Za-z0-9_$])/g, "Imperator")
    .replace(/(?<![A-Za-z0-9_$])Hermes(?![A-Za-z0-9_$])/g, "Imperator");
}

export function imperatorThemeLabel(label: string): string {
  return label.replace(/Hermes/gi, "Imperator");
}

const UPSTREAM_DOCS_PREFIX = "https://hermes-agent.nousresearch.com/docs/";

/**
 * The full manual ships inside the dashboard (see pages/DocsPage.tsx), so
 * backend-supplied links into the upstream docs site are rewritten onto
 * the in-app /docs route at render time. Non-docs URLs pass through.
 */
export function imperatorDocsHref(url: string): string {
  if (!url.startsWith(UPSTREAM_DOCS_PREFIX)) return url;
  const path = url
    .slice(UPSTREAM_DOCS_PREFIX.length)
    .replace(/[#?].*$/, "")
    .replace(/\/$/, "");
  return path ? `/docs?page=${encodeURIComponent(path)}` : "/docs";
}
