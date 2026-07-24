import { useEffect, useMemo, useState } from "react";
import { Button } from "@nous-research/ui/ui/components/button";
import { Input } from "@nous-research/ui/ui/components/input";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { FileText, Hash, Link2, Plus, RefreshCw, Search } from "lucide-react";

import { usePageHeader } from "@/contexts/usePageHeader";
import { useIntent } from "@/hooks/useIntent";
import { EmptyState } from "@/components/EmptyState";
import { Markdown } from "@/components/Markdown";
import { api } from "@/lib/api";
import { useData } from "@/lib/use-data";
import { cn, timeAgo } from "@/lib/utils";

/**
 * Obsidian vault — desktop three-pane: note list, rendered reader, and an
 * outline + backlinks rail. Notes render as notes (real headings and links via
 * Markdown), not raw source. Frontmatter is shown as clean properties.
 */
export default function VaultPage() {
  const { setTitle } = usePageHeader();
  useEffect(() => setTitle("Vault"), [setTitle]);

  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  // Command-palette entries: "New note" opens the inline creator, "Search
  // vault" focuses the search field, both after navigation to /vault. The
  // @nous-research Input isn't a forwardRef component, so we reach the native
  // element by id rather than a React ref.
  useIntent("vault:new-note", () => setCreating(true));
  useIntent("vault:search", () => {
    const el = document.getElementById("vault-search") as HTMLInputElement | null;
    el?.focus();
    el?.select();
  });

  const status = useData("vault:status", api.getVaultStatus);
  const configured = !!status.data?.configured;
  const notes = useData(configured ? "vault:notes" : null, api.listVaultNotes);
  const search = useData(
    configured && submitted ? `vault:search:${submitted}` : null,
    () => api.searchVault(submitted),
  );
  const note = useData(selected ? `vault:note:${selected}` : null, () => api.getVaultNote(selected!));
  const backlinks = useData(
    selected ? `vault:backlinks:${selected}` : null,
    () => api.getVaultBacklinks(selected!),
  );

  const rows = useMemo(() => {
    if (submitted && search.data) {
      return search.data.results.map((r) => ({ path: r.path, title: r.title, snippet: r.snippet }));
    }
    return (notes.data?.notes ?? []).map((n) => ({
      path: n.path,
      title: n.title,
      snippet: timeAgo(n.mtime * 1000),
    }));
  }, [submitted, search.data, notes.data]);

  const createNote = async () => {
    const name = newName.trim();
    if (!name) return;
    const path = name.endsWith(".md") ? name : `${name}.md`;
    try {
      await api.createVaultNote(path, `# ${name.replace(/\.md$/, "")}\n\n`);
      setNewName("");
      setCreating(false);
      notes.mutate();
      setSelected(path);
    } catch {
      /* surfaced by note load; keep it simple */
    }
  };

  if (status.isLoading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-text-secondary">
        <Spinner /> Loading vault…
      </div>
    );
  }

  if (!configured) {
    return (
      <div className="mx-auto max-w-md p-8 text-center" role="status">
        <FileText className="mx-auto mb-3 size-8 text-text-tertiary" aria-hidden />
        <h1 className="text-lg font-semibold">No vault configured</h1>
        <p className="mt-2 text-sm text-text-secondary">
          Point Imperator at your Obsidian vault: set <code>HERMES_VAULT_PATH</code> or{" "}
          <code>vault.path</code> in config on the server, then retry.
        </p>
        <Button className="mt-4" outlined prefix={<RefreshCw />} onClick={() => status.mutate()}>
          Retry
        </Button>
      </div>
    );
  }

  const n = note.data;

  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-3 p-3 lg:grid-cols-[17rem_1fr_15rem]">
      {/* List */}
      <aside className="flex min-h-0 flex-col rounded-lg border border-border">
        <div className="flex items-center gap-1.5 border-b border-border p-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-text-tertiary" aria-hidden />
            <Input
              id="vault-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && setSubmitted(query.trim())}
              placeholder="Search vault…"
              aria-label="Search vault"
              className="h-8 pl-7 text-sm"
            />
          </div>
          <Button ghost size="icon" onClick={() => setCreating((v) => !v)} aria-label="New note" title="New note">
            <Plus />
          </Button>
        </div>
        {creating && (
          <div className="border-b border-border p-2">
            <Input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void createNote();
                if (e.key === "Escape") setCreating(false);
              }}
              placeholder="note-name"
              aria-label="New note name"
              className="h-8 text-sm"
            />
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto p-1" role="list" aria-label="Notes">
          {notes.isLoading ? (
            <div className="flex items-center justify-center gap-2 p-4 text-xs text-text-secondary">
              <Spinner /> Loading…
            </div>
          ) : rows.length === 0 ? (
            <p className="p-4 text-center text-xs text-text-secondary">
              {submitted ? "No matches." : "Vault is empty."}
            </p>
          ) : (
            rows.map((r) => (
              <button
                key={r.path}
                type="button"
                role="listitem"
                onClick={() => setSelected(r.path)}
                aria-current={r.path === selected ? "true" : undefined}
                className={cn(
                  "flex w-full flex-col gap-0.5 rounded px-2 py-1.5 text-left",
                  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/40",
                  r.path === selected ? "bg-primary/10 text-foreground" : "hover:bg-midground/5 text-text-secondary",
                )}
              >
                <span className="truncate text-sm font-medium">{r.title}</span>
                <span className="truncate text-[0.6875rem] text-text-tertiary">{r.snippet}</span>
              </button>
            ))
          )}
        </div>
      </aside>

      {/* Reader */}
      <main className="min-h-0 overflow-y-auto rounded-lg border border-border">
        {!selected ? (
          <EmptyState
            icon={FileText}
            title="No note selected"
            hint="Pick a note from the list to read it here."
          />
        ) : note.isLoading || !n ? (
          <div className="flex h-full items-center justify-center gap-2 p-8 text-sm text-text-secondary">
            <Spinner /> Loading note…
          </div>
        ) : (
          <article className="mx-auto max-w-2xl p-6">
            <h1 className="text-xl font-semibold">{n.title}</h1>
            <p className="mt-1 text-xs text-text-tertiary">{n.path}</p>
            {Object.keys(n.frontmatter).length > 0 && (
              <dl className="my-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg border border-border/60 bg-midground/[0.03] p-3 text-sm">
                {Object.entries(n.frontmatter).map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-text-tertiary">{k}</dt>
                    <dd className="min-w-0 truncate text-foreground">{formatValue(v)}</dd>
                  </div>
                ))}
              </dl>
            )}
            {n.tags.length > 0 && (
              <div className="mb-4 flex flex-wrap gap-1.5">
                {n.tags.map((t) => (
                  <span key={t} className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
                    <Hash className="size-3" aria-hidden /> {t}
                  </span>
                ))}
              </div>
            )}
            <Markdown content={n.body} />
          </article>
        )}
      </main>

      {/* Outline + backlinks */}
      <aside className="hidden min-h-0 flex-col gap-3 overflow-y-auto lg:flex">
        {n && n.headings.length > 0 && (
          <section className="rounded-lg border border-border p-3">
            <h2 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-text-tertiary">Outline</h2>
            <ul className="flex flex-col gap-0.5 text-sm">
              {n.headings.map((h, i) => (
                <li key={i} style={{ paddingLeft: `${(h.level - 1) * 10}px` }} className="truncate text-text-secondary">
                  {h.text}
                </li>
              ))}
            </ul>
          </section>
        )}
        <section className="rounded-lg border border-border p-3">
          <h2 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-text-tertiary">
            <Link2 className="size-3.5" aria-hidden /> Backlinks
          </h2>
          {!selected ? (
            <p className="text-xs text-text-tertiary">—</p>
          ) : (backlinks.data?.backlinks ?? []).length === 0 ? (
            <p className="text-xs text-text-tertiary">No backlinks.</p>
          ) : (
            <ul className="flex flex-col gap-1.5 text-sm">
              {backlinks.data!.backlinks.map((b) => (
                <li key={b.path}>
                  <button
                    type="button"
                    onClick={() => setSelected(b.path)}
                    className="w-full text-left text-primary hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/40"
                  >
                    {b.title}
                  </button>
                  {b.context && <p className="truncate text-xs text-text-tertiary">{b.context}</p>}
                </li>
              ))}
            </ul>
          )}
        </section>
      </aside>
    </div>
  );
}

function formatValue(v: unknown): string {
  if (Array.isArray(v)) return v.join(", ");
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
