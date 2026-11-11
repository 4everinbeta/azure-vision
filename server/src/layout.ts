export interface LayoutNode { id: string; width: number; height: number; partition?: number }
export interface LayoutEdge { id: string; source: string; target: string }
export interface LayoutRequest { nodes: LayoutNode[]; edges: LayoutEdge[] }
export type Positions = Record<string, { x: number; y: number }>;

export interface ElkGraph {
  id: string;
  layoutOptions: Record<string, string>;
  children: { id: string; width: number; height: number; layoutOptions: Record<string, string> }[];
  edges: { id: string; sources: string[]; targets: string[] }[];
}

/** Nodes are partitioned (e.g. by role), so the diagram reads left to right in partition order. */
export function buildElkGraph({ nodes, edges }: LayoutRequest): ElkGraph {
  const ids = new Set(nodes.map((n) => n.id));
  return {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.edgeRouting": "SPLINES",
      "elk.partitioning.activate": "true",
      "elk.spacing.nodeNode": "28",
      "elk.layered.spacing.nodeNodeBetweenLayers": "80",
      "elk.spacing.componentComponent": "40",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
    },
    children: nodes.map((n) => ({
      id: n.id, width: n.width, height: n.height,
      layoutOptions: { "elk.partitioning.partition": String(n.partition ?? 0) },
    })),
    edges: edges.filter((e) => ids.has(e.source) && ids.has(e.target))
      .map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  };
}

let elk: Promise<{ layout(g: ElkGraph): Promise<{ children?: { id: string; x?: number; y?: number }[] }> }> | undefined;
const engine = () => (elk ??= import("elkjs/lib/elk.bundled.js").then((m) => new m.default()));

export async function computeLayout(req: LayoutRequest): Promise<Positions> {
  const laid = await (await engine()).layout(buildElkGraph(req));
  return Object.fromEntries((laid.children ?? []).map((c) => [c.id, { x: c.x ?? 0, y: c.y ?? 0 }]));
}
