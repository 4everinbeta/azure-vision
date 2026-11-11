import type { Edge, Node } from "@xyflow/react";
import type { Inventory, Resource } from "@azure-vision/shared";

export const VNET_W = 230;
const GAP = 60, MAX_SUBNETS = 6;
export const vnetHeight = (r: Resource) =>
  64 + Math.min(subnetsOf(r).length, MAX_SUBNETS) * 16 + (subnetsOf(r).length > MAX_SUBNETS ? 16 : 0);

export const subnetsOf = (r: Resource): { name: string; prefix: string }[] =>
  ((r.properties as any).subnets ?? []).map((s: any) => ({
    name: s.name,
    prefix: s.properties?.addressPrefix ?? s.properties?.addressPrefixes?.join(", ") ?? "",
  }));

export const addressSpaceOf = (r: Resource): string[] => (r.properties as any).addressSpace?.addressPrefixes ?? [];

const PALETTE = ["#0078d4", "#107c10", "#c239b3", "#d83b01", "#008272", "#8661c5", "#986f0b", "#005b70"];

export interface NetworkLayout {
  nodes: Node[];
  edges: Edge[];
  legend: { subscription: string; color: string }[];
}

/**
 * Hub-and-spoke layout: peered VNets form groups; the most-connected VNet in a group is the hub,
 * its peers sit on a ring around it. VNets with no peerings go in a grid underneath.
 */
export function layoutNetwork(inv: Inventory): NetworkLayout {
  const vnets = inv.resources.filter((r) => r.type === "microsoft.network/virtualnetworks");
  const ids = new Set(vnets.map((v) => v.id));
  const peerings = inv.edges.filter((e) => e.kind === "peering" && ids.has(e.source) && ids.has(e.target));

  const subs = [...new Set(vnets.map((v) => v.subscriptionId))].sort();
  const color = new Map(subs.map((s, i) => [s, PALETTE[i % PALETTE.length]]));
  const legend = subs.map((s) => ({
    subscription: vnets.find((v) => v.subscriptionId === s)?.subscriptionName ?? s,
    color: color.get(s)!,
  }));

  const adj = new Map<string, Set<string>>(vnets.map((v) => [v.id, new Set()]));
  for (const e of peerings) { adj.get(e.source)!.add(e.target); adj.get(e.target)!.add(e.source); }

  // Connected components via DFS.
  const seen = new Set<string>();
  const groups: Resource[][] = [];
  const byId = new Map(vnets.map((v) => [v.id, v]));
  for (const v of vnets) {
    if (seen.has(v.id) || adj.get(v.id)!.size === 0) continue;
    const stack = [v.id], group: Resource[] = [];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      group.push(byId.get(id)!);
      stack.push(...adj.get(id)!);
    }
    groups.push(group);
  }
  groups.sort((a, b) => b.length - a.length);

  const nodes: Node[] = [];
  const add = (r: Resource, x: number, y: number) =>
    nodes.push({
      id: r.id, type: "vnet", position: { x, y },
      data: { resource: r, color: color.get(r.subscriptionId) },
      style: { width: VNET_W, height: vnetHeight(r) },
    });

  let offsetX = 0, maxBottom = 0;
  for (const group of groups) {
    const hub = [...group].sort((a, b) => adj.get(b.id)!.size - adj.get(a.id)!.size || a.name.localeCompare(b.name))[0];
    const spokes = group.filter((g) => g !== hub).sort((a, b) =>
      a.subscriptionId.localeCompare(b.subscriptionId) || a.name.localeCompare(b.name));
    const radius = Math.max(340, (spokes.length * (VNET_W + GAP)) / (2 * Math.PI));
    const cx = offsetX + radius + VNET_W / 2, cy = radius + 100;
    add(hub, cx - VNET_W / 2, cy - vnetHeight(hub) / 2);
    spokes.forEach((s, i) => {
      const a = (2 * Math.PI * i) / spokes.length - Math.PI / 2;
      add(s, cx + radius * Math.cos(a) - VNET_W / 2, cy + radius * Math.sin(a) - vnetHeight(s) / 2);
    });
    offsetX += 2 * radius + VNET_W + 120;
    maxBottom = Math.max(maxBottom, cy + radius + 120);
  }

  // Isolated VNets.
  const isolated = vnets.filter((v) => !seen.has(v.id)).sort((a, b) => a.name.localeCompare(b.name));
  const cols = Math.max(1, Math.min(5, Math.ceil(Math.sqrt(isolated.length))));
  isolated.forEach((v, i) => add(v, (i % cols) * (VNET_W + GAP), maxBottom + Math.floor(i / cols) * 200));

  const edges: Edge[] = peerings.map((e) => ({
    id: e.id, source: e.source, target: e.target, type: "straight",
    style: { stroke: "#5c2d91", strokeWidth: 3 },
  }));
  return { nodes, edges, legend };
}
