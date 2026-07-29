import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Share2 } from "lucide-react";

import { useCapabilities } from "@/capabilities/useCapabilities";
import { capabilityPath } from "@/capabilities/registry";
import { entityTypeOf } from "@/capabilities/types";
import { layoutGraph, neighborsOf } from "@/capabilities/graph-layout";
import { emitIntent } from "@/lib/app-intent";
import { api, type EntityGraphResponse } from "@/lib/api";
import { cn } from "@/lib/utils";

const W = 1000;
const H = 620;

/**
 * Relationships graph — every record and the links between them, laid out in
 * one column per capability. Hovering a node highlights its connections;
 * clicking opens the record in its area. Reads the same links the LinkPanel
 * writes, so any capability's records appear here with no per-type code.
 */
export function GraphPage() {
  const navigate = useNavigate();
  const { capabilities } = useCapabilities();
  const [graph, setGraph] = useState<EntityGraphResponse>({ nodes: [], edges: [] });
  const [loaded, setLoaded] = useState(false);
  const [hover, setHover] = useState<string | null>(null);

  const byType = useMemo(() => {
    const map = new Map<string, (typeof capabilities)[number]>();
    for (const cap of capabilities) map.set(entityTypeOf(cap), cap);
    return map;
  }, [capabilities]);

  useEffect(() => {
    let cancelled = false;
    api
      .getEntityGraph()
      .then((res) => {
        if (!cancelled) setGraph(res);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const labelOf = (node: { type: string; id: string; data: Record<string, unknown> }) => {
    const cap = byType.get(node.type);
    return String((cap && node.data[cap.titleField]) ?? node.id);
  };

  const nodes = useMemo(
    () =>
      layoutGraph(
        graph.nodes.map((n) => ({ id: n.id, type: n.type, label: labelOf(n) })),
        { width: W, height: H },
      ),
    // labelOf depends on byType; recompute when graph or capabilities change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [graph.nodes, byType],
  );
  const pos = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const active = useMemo(
    () => (hover ? neighborsOf(hover, graph.edges) : null),
    [hover, graph.edges],
  );

  const open = (type: string, id: string) => {
    const cap = byType.get(type);
    if (!cap) return;
    navigate(capabilityPath(cap));
    emitIntent("entity:open", { type, id });
  };

  const dim = (id: string) => hover !== null && hover !== id && !active?.has(id);

  return (
    <div className="mx-auto flex min-h-0 max-w-6xl flex-col gap-3 p-4 sm:p-6">
      <div className="flex items-center gap-2">
        <Share2 className="size-5 text-midground" aria-hidden />
        <h1 className="text-lg font-semibold">Relationships</h1>
        <span className="text-xs text-text-tertiary">
          {graph.nodes.length} records · {graph.edges.length} links
        </span>
      </div>

      {loaded && graph.edges.length === 0 ? (
        <p className="px-1 text-sm text-text-tertiary">
          No links yet. Open a record and use “Add link” to connect it to another
          — connections show up here.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-background-elevated">
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="h-[62vh] w-full min-w-[680px]"
            role="img"
            aria-label="Relationships graph"
          >
            {/* Edges behind nodes. */}
            {graph.edges.map((e, i) => {
              const a = pos.get(e.source);
              const b = pos.get(e.target);
              if (!a || !b) return null;
              const on = hover === null || hover === e.source || hover === e.target;
              const mx = (a.x + b.x) / 2;
              return (
                <path
                  key={i}
                  d={`M ${a.x} ${a.y} C ${mx} ${a.y}, ${mx} ${b.y}, ${b.x} ${b.y}`}
                  fill="none"
                  className={cn(
                    "stroke-current transition-opacity",
                    on ? "text-midground/50" : "text-current/10",
                  )}
                  strokeWidth={1.5}
                />
              );
            })}
            {/* Nodes. */}
            {nodes.map((n) => (
              <g
                key={n.id}
                transform={`translate(${n.x} ${n.y})`}
                className={cn(
                  "cursor-pointer transition-opacity",
                  dim(n.id) ? "opacity-30" : "opacity-100",
                )}
                onMouseEnter={() => setHover(n.id)}
                onMouseLeave={() => setHover(null)}
                onClick={() => open(n.type, n.id)}
                role="button"
                aria-label={`${n.label} (${byType.get(n.type)?.label ?? n.type})`}
              >
                <circle
                  r={7}
                  className={cn(
                    "stroke-background-elevated",
                    hover === n.id ? "fill-midground" : "fill-primary/70",
                  )}
                  strokeWidth={2}
                />
                <text
                  x={11}
                  y={4}
                  className="fill-current text-[13px] text-text-secondary"
                >
                  {n.label.length > 22 ? `${n.label.slice(0, 21)}…` : n.label}
                </text>
              </g>
            ))}
          </svg>
        </div>
      )}
    </div>
  );
}

export default GraphPage;
