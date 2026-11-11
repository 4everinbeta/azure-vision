import type { Node } from "@xyflow/react";
import { formatCost, type CostData, type CostRollup } from "@azure-vision/shared";

export interface CostView { rollup: CostRollup; currency: string; heat: boolean }

/** Log-scaled white-to-red heat colour; undefined for resources without cost. */
export const heatColor = (cost: number | undefined, max: number): string | undefined =>
  cost && max > 0 ? `hsl(${Math.round(55 - 55 * Math.min(1, Math.log1p(cost) / Math.log1p(max)))}, 90%, 88%)` : undefined;

/** Adds cost labels and heat colours to laid-out nodes; a card's cost includes the resources folded into it. */
export function decorateNodes(nodes: Node[], view: CostView): Node[] {
  const { rollup, currency, heat } = view;
  const fmt = (v: number) => formatCost(v, currency);
  const totals = new Map<string, number>();
  for (const n of nodes) {
    const d = n.data as { resource?: { id: string }; children?: { id: string }[] };
    if (!d.resource) continue;
    const ids = [d.resource.id, ...(d.children ?? []).map((c) => c.id)];
    const known = ids.filter((id) => rollup.resource.has(id));
    if (known.length) totals.set(n.id, known.reduce((sum, id) => sum + rollup.resource.get(id)!, 0));
  }
  const max = Math.max(0, ...totals.values());
  return nodes.map((n) => {
    const cost = totals.get(n.id);
    return cost === undefined ? n
      : { ...n, data: { ...n.data, costLabel: fmt(cost), heatColor: heat ? heatColor(cost, max) : undefined } };
  });
}

export type { CostData };
