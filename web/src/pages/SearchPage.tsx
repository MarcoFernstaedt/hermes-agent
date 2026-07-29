import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Search as SearchIcon, CornerDownLeft, Package } from "lucide-react";

import { useCapabilities } from "@/capabilities/useCapabilities";
import { capabilityPath } from "@/capabilities/registry";
import { entityTypeOf } from "@/capabilities/types";
import { emitIntent } from "@/lib/app-intent";
import { api, type Entity } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * Cross-entity search — one box over every capability's records (reading,
 * tasks, contacts, …). Types into the full-text index the entity store keeps
 * (GET /api/entities/search) and, on select, jumps to the record's capability
 * area and opens it (via the "entity:open" intent). New capabilities appear
 * here automatically — nothing is hard-coded per type.
 */
export function SearchPage() {
  const navigate = useNavigate();
  const { capabilities } = useCapabilities();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [results, setResults] = useState<Entity[]>([]);
  // The query `results` correspond to; when it lags `debounced`, a fetch is in
  // flight (derived `busy`), which avoids setting a loading flag inside the
  // effect body.
  const [loadedFor, setLoadedFor] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Map an entity type to its declaration so a result can show the right
  // title/subtitle/icon and route without knowing types ahead of time.
  const byType = useMemo(() => {
    const map = new Map<string, (typeof capabilities)[number]>();
    for (const cap of capabilities) map.set(entityTypeOf(cap), cap);
    return map;
  }, [capabilities]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Debounce so a fast typist fires one request, not one per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 200);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    // Empty query: nothing to fetch. The effect only sets state from async
    // callbacks (never synchronously), so it can't cascade renders.
    if (!debounced) return;
    let cancelled = false;
    api
      .searchEntities(debounced, { limit: 40 })
      .then((res) => {
        if (cancelled) return;
        setResults(res.items);
        setSelected(0);
        setLoadedFor(debounced);
      })
      .catch(() => {
        if (cancelled) return;
        setResults([]);
        setLoadedFor(debounced);
      });
    return () => {
      cancelled = true;
    };
  }, [debounced]);

  // Show results only once they match the current query; while a fetch is in
  // flight (loadedFor lagging debounced) show the spinner and no stale rows.
  const visible = debounced && loadedFor === debounced ? results : [];
  const busy = !!debounced && loadedFor !== debounced;

  const open = (entity: Entity) => {
    const cap = byType.get(entity.type);
    if (!cap) return;
    navigate(capabilityPath(cap));
    emitIntent("entity:open", { type: entity.type, id: entity.id });
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelected((c) => Math.min(c + 1, visible.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelected((c) => Math.max(c - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const hit = visible[Math.min(selected, visible.length - 1)];
      if (hit) open(hit);
    }
  };

  return (
    <div className="mx-auto flex min-h-0 max-w-3xl flex-col gap-4 p-4 sm:p-6">
      <div className="flex items-center gap-2 rounded-lg border border-current/20 bg-background-elevated px-3">
        <SearchIcon className="size-4 shrink-0 text-text-tertiary" aria-hidden />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search all records…"
          aria-label="Search all records"
          className="min-w-0 flex-1 bg-transparent py-3 text-base text-foreground outline-none placeholder:text-text-tertiary sm:text-sm"
        />
        {busy && <span className="shrink-0 text-xs text-text-tertiary">…</span>}
      </div>

      {!debounced ? (
        <p className="px-1 text-sm text-text-tertiary">
          Type to search across every area — reading, tasks, contacts and more.
        </p>
      ) : visible.length === 0 && !busy ? (
        <p className="px-1 text-sm text-text-tertiary">No matches for “{debounced}”.</p>
      ) : (
        <ul role="listbox" aria-label="Search results" className="flex flex-col gap-1">
          {visible.map((entity, index) => {
            const cap = byType.get(entity.type);
            const Icon = cap?.icon ?? Package;
            const title = String(
              (cap && entity.data[cap.titleField]) ?? entity.id,
            );
            const subtitle =
              cap?.subtitleField != null
                ? String(entity.data[cap.subtitleField] ?? "")
                : "";
            const active = index === Math.min(selected, visible.length - 1);
            return (
              <li
                key={entity.id}
                role="option"
                aria-selected={active}
                onMouseEnter={() => setSelected(index)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  open(entity);
                }}
                className={cn(
                  "flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-3 py-2",
                  active ? "bg-midground/10 text-midground" : "text-text-secondary",
                )}
              >
                <Icon className="size-4 shrink-0" aria-hidden />
                <span className="min-w-0 flex-1 truncate">
                  <span className="text-sm">{title}</span>
                  {subtitle && (
                    <span className="ml-2 text-xs text-text-tertiary">{subtitle}</span>
                  )}
                </span>
                <span className="shrink-0 text-xs tracking-wide text-text-tertiary">
                  {cap?.label ?? entity.type}
                </span>
                {active && (
                  <CornerDownLeft
                    className="size-3.5 shrink-0 text-text-tertiary"
                    aria-hidden
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default SearchPage;
