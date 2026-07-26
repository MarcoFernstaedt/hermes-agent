import { useEffect, useMemo, useRef, useState } from "react";
import { Link2, Plus, Search as SearchIcon, X, Package } from "lucide-react";

import { api, type EntityLinkItem, type Entity } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useCapabilities } from "./useCapabilities";
import { entityTypeOf } from "./types";

/**
 * LinkPanel — view and manage a record's links to other records, across every
 * capability. Shown inside the record editor once a record exists (it needs an
 * id to link). Links are undirected: adding one here surfaces it on both
 * records. Titles/icons for linked records are resolved from the declarations,
 * so any capability's records are linkable with no per-type code.
 */
export function LinkPanel({ type, id }: { type: string; id: string }) {
  const { capabilities } = useCapabilities();
  const [links, setLinks] = useState<EntityLinkItem[]>([]);
  const [reload, setReload] = useState(0);
  const [adding, setAdding] = useState(false);

  const byType = useMemo(() => {
    const map = new Map<string, (typeof capabilities)[number]>();
    for (const cap of capabilities) map.set(entityTypeOf(cap), cap);
    return map;
  }, [capabilities]);

  useEffect(() => {
    let cancelled = false;
    api
      .listLinks(type, id)
      .then((res) => {
        if (!cancelled) setLinks(res.items);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [type, id, reload]);

  const linkedIds = useMemo(() => new Set(links.map((l) => l.id)), [links]);

  const titleOf = (item: { type: string; id: string; data: Record<string, unknown> }) => {
    const cap = byType.get(item.type);
    return String((cap && item.data[cap.titleField]) ?? item.id);
  };
  const iconOf = (t: string) => byType.get(t)?.icon ?? Package;
  const labelOf = (t: string) => byType.get(t)?.label ?? t;

  const add = async (targetId: string) => {
    await api.createLink(type, id, targetId).catch(() => undefined);
    setAdding(false);
    setReload((n) => n + 1);
  };
  const remove = async (targetId: string) => {
    await api.deleteLink(type, id, targetId).catch(() => undefined);
    setReload((n) => n + 1);
  };

  return (
    <div className="mt-4 border-t border-border pt-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs font-medium text-text-secondary">
          <Link2 className="size-3.5" aria-hidden />
          Linked {links.length > 0 && <span className="text-text-tertiary">({links.length})</span>}
        </span>
        <button
          type="button"
          onClick={() => setAdding((v) => !v)}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-midground hover:bg-midground/10"
        >
          <Plus className="size-3.5" aria-hidden /> Add link
        </button>
      </div>

      {adding && (
        <LinkSearch
          excludeIds={new Set([id, ...linkedIds])}
          onPick={add}
          titleOf={titleOf}
          iconOf={iconOf}
          labelOf={labelOf}
        />
      )}

      {links.length === 0 ? (
        !adding && (
          <p className="text-xs text-text-tertiary">No links yet.</p>
        )
      ) : (
        <ul className="flex flex-col gap-1">
          {links.map((l) => {
            const Icon = iconOf(l.type);
            return (
              <li
                key={`${l.id}:${l.rel}`}
                className="flex items-center gap-2 rounded-md bg-background-elevated px-2 py-1.5 text-sm"
              >
                <Icon className="size-4 shrink-0 text-text-tertiary" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{titleOf(l)}</span>
                <span className="shrink-0 text-xs text-text-tertiary">{labelOf(l.type)}</span>
                <button
                  type="button"
                  onClick={() => remove(l.id)}
                  aria-label={`Remove link to ${titleOf(l)}`}
                  className="shrink-0 rounded p-0.5 text-text-tertiary hover:bg-midground/10 hover:text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Inline record picker used by the Add-link affordance. */
function LinkSearch({
  excludeIds,
  onPick,
  titleOf,
  iconOf,
  labelOf,
}: {
  excludeIds: Set<string>;
  onPick: (id: string) => void;
  titleOf: (e: Entity) => string;
  iconOf: (type: string) => React.ComponentType<{ className?: string }>;
  labelOf: (type: string) => string;
}) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [results, setResults] = useState<Entity[]>([]);
  const [loadedFor, setLoadedFor] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  // The picker mounts on an explicit "Add link" click; move focus to it.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 200);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    if (!debounced) return;
    let cancelled = false;
    api
      .searchEntities(debounced, { limit: 8 })
      .then((res) => {
        if (cancelled) return;
        setResults(res.items);
        setLoadedFor(debounced);
      })
      .catch(() => {
        if (!cancelled) {
          setResults([]);
          setLoadedFor(debounced);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [debounced]);

  const visible =
    debounced && loadedFor === debounced
      ? results.filter((r) => !excludeIds.has(r.id))
      : [];

  return (
    <div className="mb-2">
      <div className="flex items-center gap-2 rounded-md border border-current/20 bg-background-elevated px-2">
        <SearchIcon className="size-3.5 shrink-0 text-text-tertiary" aria-hidden />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search records to link…"
          aria-label="Search records to link"
          className="min-w-0 flex-1 bg-transparent py-1.5 text-sm outline-none placeholder:text-text-tertiary"
        />
      </div>
      {visible.length > 0 && (
        <ul className="mt-1 flex flex-col gap-0.5">
          {visible.map((r) => {
            const Icon = iconOf(r.type);
            return (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => onPick(r.id)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm",
                    "text-text-secondary hover:bg-midground/10 hover:text-foreground",
                  )}
                >
                  <Icon className="size-4 shrink-0 text-text-tertiary" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{titleOf(r)}</span>
                  <span className="shrink-0 text-xs text-text-tertiary">{labelOf(r.type)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
