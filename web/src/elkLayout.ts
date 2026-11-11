import type { Edge, Node } from "@xyflow/react";
import { groupChildren, roleOf, roleOrder, type Inventory, type Resource } from "@azure-vision/shared";
import { authHeaders } from "./auth";

export const CARD_W = 190, CARD_H = 76;

const byRole = (a: Resource, b: Resource) =>
  roleOrder.indexOf(roleOf(a.type)) - roleOrder.indexOf(roleOf(b.type)) || a.type.localeCompare(b.type) || a.name.localeCompare(b.name);

/** Resource-group diagram: collapsed cards, positioned by the layout service (ELK, left to right by role). */
export async function layoutResourceGroup(inv: Inventory): Promise<{ nodes: Node[]; edges: Edge[] }> {
  const g = groupChildren(inv.resources, inv.edges);
  const primary = [...g.primary].sort(byRole);
  const ids = new Set(primary.map((r) => r.id));
  const edges = g.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
  const res = await fetch("/api/layout", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify({
      nodes: primary.map((r) => ({ id: r.id, width: CARD_W, height: CARD_H, partition: roleOrder.indexOf(roleOf(r.type)) })),
      edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
    }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Layout service: HTTP ${res.status}`);
  const { positions } = (await res.json()) as { positions: Record<string, { x: number; y: number }> };
  const nodes: Node[] = primary.map((r) => ({
    id: r.id, type: "card", position: positions[r.id] ?? { x: 0, y: 0 },
    data: { resource: r, children: g.children.get(r.id) ?? [] },
    style: { width: CARD_W, height: CARD_H }, draggable: false,
  }));
  return {
    nodes,
    edges: edges.map((e) => ({
      id: e.id, source: e.source, target: e.target, type: "default", data: { kind: e.kind },
      label: e.kind === "peering" ? "peering" : undefined,
    })),
  };
}
