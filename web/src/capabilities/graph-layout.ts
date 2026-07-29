/**
 * Deterministic layout for the relationships graph: records are laid out in one
 * column per entity type, evenly spaced within each column. Pure and
 * unit-tested; the GraphPage renders SVG over these coordinates. A columnar
 * layout (rather than a physics simulation) keeps the view stable across
 * renders and avoids pulling in a graph library.
 */

export interface GraphInputNode {
  id: string;
  type: string;
  label: string;
}

export interface LaidOutNode extends GraphInputNode {
  x: number;
  y: number;
  col: number;
}

export interface LayoutOptions {
  width: number;
  height: number;
  padding?: number;
}

/** Position nodes into type-columns. Column order follows first appearance. */
export function layoutGraph(
  nodes: readonly GraphInputNode[],
  { width, height, padding = 48 }: LayoutOptions,
): LaidOutNode[] {
  const types: string[] = [];
  const byType = new Map<string, GraphInputNode[]>();
  for (const n of nodes) {
    let bucket = byType.get(n.type);
    if (!bucket) {
      bucket = [];
      byType.set(n.type, bucket);
      types.push(n.type);
    }
    bucket.push(n);
  }

  const colCount = types.length;
  const out: LaidOutNode[] = [];
  types.forEach((type, ci) => {
    const column = byType.get(type)!;
    const x =
      colCount <= 1
        ? width / 2
        : padding + (ci * (width - 2 * padding)) / (colCount - 1);
    column.forEach((node, ri) => {
      const y =
        column.length <= 1
          ? height / 2
          : padding + (ri * (height - 2 * padding)) / (column.length - 1);
      out.push({ ...node, x, y, col: ci });
    });
  });
  return out;
}

/** Set of node ids directly connected to `id` (either edge direction). */
export function neighborsOf(
  id: string,
  edges: readonly { source: string; target: string }[],
): Set<string> {
  const out = new Set<string>();
  for (const e of edges) {
    if (e.source === id) out.add(e.target);
    else if (e.target === id) out.add(e.source);
  }
  return out;
}
