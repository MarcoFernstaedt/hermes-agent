import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { BookOpen, ChevronDown, ChevronRight, ListTree, Search, X } from "lucide-react";
import { Button } from "@nous-research/ui/ui/components/button";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { Markdown } from "@/components/Markdown";
import { usePageHeader } from "@/contexts/usePageHeader";
import {
  DOCS_MANIFEST,
  docTitle,
  hasDocPage,
  flattenDocs,
  imperatorDocText,
  loadDocPage,
  preprocessDoc,
  type DocNode,
} from "@/lib/docs";
import { cn } from "@/lib/utils";
import { PluginSlot } from "@/plugins";

const DEFAULT_PAGE = "getting-started/quickstart";

/**
 * In-app documentation. The complete manual is bundled with the dashboard
 * (see src/lib/docs.ts) and rendered natively in the Imperator scheme —
 * no external docs site, no iframe, works offline.
 */
export default function DocsPage() {
  const { setTitle } = usePageHeader();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const page = searchParams.get("page") ?? DEFAULT_PAGE;

  // Loaded body keyed by page id: a stale entry simply reads as "loading"
  // for the current page, so no synchronous state resets are needed when
  // navigation changes the page param.
  const [loaded, setLoaded] = useState<{
    page: string;
    body: string;
  } | null>(null);
  const [failedPage, setFailedPage] = useState<string | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const [query, setQuery] = useState("");
  const contentRef = useRef<HTMLDivElement | null>(null);

  const missing = !hasDocPage(page) || failedPage === page;
  const body = loaded?.page === page ? loaded.body : null;
  const title = docTitle(page);

  useLayoutEffect(() => {
    setTitle(title ? imperatorDocText(title) : "Documentation");
    return () => setTitle(null);
  }, [setTitle, title]);

  // Load the selected page's markdown chunk.
  useEffect(() => {
    let cancelled = false;
    const loader = loadDocPage(page);
    if (!loader) return;
    loader.then(
      (raw) => {
        if (cancelled) return;
        setLoaded({ page, body: preprocessDoc(raw, page) });
        contentRef.current?.closest("main")?.scrollTo({ top: 0 });
      },
      () => {
        if (!cancelled) setFailedPage(page);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [page]);

  // Plain handlers — the React Compiler memoizes these; manual useCallback
  // fights its inference here.
  const openPage = (next: string) => {
    setSearchParams((params) => {
      const merged = new URLSearchParams(params);
      merged.set("page", next);
      return merged;
    });
    setNavOpen(false);
  };

  // Keep in-app doc links inside the SPA instead of full page reloads.
  const onContentClick = (event: MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as HTMLElement).closest?.("a");
    if (!anchor) return;
    const href = anchor.getAttribute("href") ?? "";
    if (!href.startsWith("/")) return;
    event.preventDefault();
    if (href.startsWith("/docs?page=")) {
      openPage(decodeURIComponent(href.slice("/docs?page=".length)));
    } else {
      navigate(href);
    }
  };

  const flat = flattenDocs();
  const ordered = useMemo(() => flat.map((d) => d.page), [flat]);
  const index = ordered.indexOf(page);
  const previous = index > 0 ? flat[index - 1] : null;
  const next = index >= 0 && index < flat.length - 1 ? flat[index + 1] : null;

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return flat
      .filter((d) =>
        imperatorDocText(`${d.title} ${d.trail} ${d.page}`)
          .toLowerCase()
          .includes(q),
      )
      .slice(0, 30);
  }, [flat, query]);

  const sidebar = (
    <nav aria-label="Documentation" className="flex min-h-0 flex-col gap-3">
      <label className="relative block">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-text-disabled" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search documentation"
          className={cn(
            "w-full border border-current/20 bg-background-base py-2 pr-3 pl-8",
            "text-sm text-foreground placeholder:text-text-disabled",
            "focus:border-primary/60 focus:outline-none",
          )}
        />
      </label>
      {results ? (
        <ul className="flex min-h-0 flex-col gap-0.5 overflow-y-auto">
          {results.length === 0 && (
            <li className="px-2 py-2 text-xs text-text-secondary">
              No pages match “{query}”.
            </li>
          )}
          {results.map((d) => (
            <li key={d.page}>
              <button
                type="button"
                onClick={() => openPage(d.page)}
                className={cn(
                  "w-full cursor-pointer px-2 py-1.5 text-left",
                  "hover:bg-midground/10",
                  d.page === page && "bg-midground/15",
                )}
              >
                <span className="block text-sm text-foreground">
                  {imperatorDocText(d.title)}
                </span>
                <span className="block truncate text-[0.65rem] text-text-secondary">
                  {imperatorDocText(d.trail)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto pb-4">
          {DOCS_MANIFEST.map((section) => (
            <div key={section.id}>
              <p className="mb-1 px-2 text-[0.65rem] font-bold tracking-[0.2em] text-text-secondary uppercase">
                {section.label}
              </p>
              <DocTree nodes={section.children} activePage={page} onOpen={openPage} />
            </div>
          ))}
        </div>
      )}
    </nav>
  );

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col px-3 pt-2 pb-6 sm:px-6 lg:flex-row lg:gap-8">
      <PluginSlot name="docs:top" />

      {/* Mobile: collapsible browser above the article. */}
      <div className="mb-3 lg:hidden">
        <Button
          size="sm"
          outlined
          onClick={() => setNavOpen((v) => !v)}
          aria-expanded={navOpen}
          prefix={navOpen ? <X /> : <ListTree />}
        >
          {navOpen ? "Close" : "Browse documentation"}
        </Button>
        {navOpen && (
          <div className="mt-3 max-h-[60vh] overflow-y-auto border border-current/20 bg-background-base p-3">
            {sidebar}
          </div>
        )}
      </div>

      {/* Desktop rail. */}
      <aside className="hidden w-64 shrink-0 lg:block">
        <div
          // Keyboard users can focus and scroll the docs tree directly.
          tabIndex={0}
          role="region"
          aria-label="Documentation navigation"
          className="sticky top-0 max-h-[calc(100vh-8rem)] overflow-y-auto pr-1 focus:outline-none focus-visible:ring-1 focus-visible:ring-primary/50"
        >
          {sidebar}
        </div>
      </aside>

      <article
        ref={contentRef}
        onClick={onContentClick}
        className="min-w-0 flex-1 lg:max-w-3xl"
      >
        {missing ? (
          <div className="flex flex-col items-start gap-3 py-10">
            <BookOpen className="size-6 text-text-disabled" />
            <p className="text-sm text-text-secondary">
              That page doesn’t exist. Pick a topic from the documentation tree.
            </p>
            <Button size="sm" outlined onClick={() => openPage(DEFAULT_PAGE)}>
              Open quickstart
            </Button>
          </div>
        ) : body === null ? (
          <div
            className="flex items-center justify-center py-16"
            aria-busy="true"
            aria-live="polite"
          >
            <Spinner className="text-2xl text-primary" />
          </div>
        ) : (
          <>
            <Markdown content={body} transformText={imperatorDocText} />
            <nav
              aria-label="More documentation"
              className="mt-8 flex flex-col gap-2 border-t border-current/20 pt-4 sm:flex-row sm:justify-between"
            >
              {previous ? (
                <button
                  type="button"
                  onClick={() => openPage(previous.page)}
                  className="cursor-pointer text-left text-sm text-primary hover:underline"
                >
                  ← {imperatorDocText(previous.title)}
                </button>
              ) : (
                <span />
              )}
              {next ? (
                <button
                  type="button"
                  onClick={() => openPage(next.page)}
                  className="cursor-pointer text-left text-sm text-primary hover:underline sm:text-right"
                >
                  {imperatorDocText(next.title)} →
                </button>
              ) : (
                <span />
              )}
            </nav>
          </>
        )}
      </article>
      <PluginSlot name="docs:bottom" />
    </div>
  );
}

/** Collapsible tree for one manifest branch. */
function DocTree({
  nodes,
  activePage,
  onOpen,
  depth = 0,
}: {
  nodes: DocNode[];
  activePage: string;
  onOpen: (page: string) => void;
  depth?: number;
}) {
  return (
    <ul className="flex flex-col gap-0.5">
      {nodes.map((node) =>
        node.kind === "doc" ? (
          <li key={node.page}>
            <button
              type="button"
              onClick={() => onOpen(node.page)}
              aria-current={node.page === activePage ? "page" : undefined}
              className={cn(
                "w-full cursor-pointer truncate px-2 py-1 text-left text-sm",
                "hover:bg-midground/10",
                node.page === activePage
                  ? "border-l-2 border-primary bg-midground/15 text-primary"
                  : "border-l-2 border-transparent text-foreground",
              )}
              style={{ paddingLeft: `${0.5 + depth * 0.75}rem` }}
            >
              {imperatorDocText(node.title)}
            </button>
          </li>
        ) : (
          <DocTreeGroup
            key={node.slug}
            node={node}
            activePage={activePage}
            onOpen={onOpen}
            depth={depth}
          />
        ),
      )}
    </ul>
  );
}

function groupContains(node: DocNode, page: string): boolean {
  if (node.kind === "doc") return node.page === page;
  return node.children.some((child) => groupContains(child, page));
}

function DocTreeGroup({
  node,
  activePage,
  onOpen,
  depth,
}: {
  node: Extract<DocNode, { kind: "group" }>;
  activePage: string;
  onOpen: (page: string) => void;
  depth: number;
}) {
  const containsActive = groupContains(node, activePage);
  // Auto state follows the active page (branches holding the open doc are
  // expanded); a manual toggle overrides until navigation moves the active
  // page in or out of this branch, which clears the override during render.
  const [override, setOverride] = useState<boolean | null>(null);
  const [prevContainsActive, setPrevContainsActive] = useState(containsActive);
  if (prevContainsActive !== containsActive) {
    setPrevContainsActive(containsActive);
    setOverride(null);
  }
  const open = override ?? containsActive;
  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <li>
      <button
        type="button"
        onClick={() => setOverride(!open)}
        aria-expanded={open}
        className={cn(
          "flex w-full cursor-pointer items-center gap-1 px-2 py-1 text-left",
          "text-sm font-semibold text-midground hover:bg-midground/10",
        )}
        style={{ paddingLeft: `${0.5 + depth * 0.75}rem` }}
      >
        <Chevron className="size-3.5 shrink-0" />
        <span className="truncate">{imperatorDocText(node.label)}</span>
      </button>
      {open && (
        <DocTree
          nodes={node.children}
          activePage={activePage}
          onOpen={onOpen}
          depth={depth + 1}
        />
      )}
    </li>
  );
}
