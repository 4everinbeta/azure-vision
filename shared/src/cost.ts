import type { Resource } from "./types";
import { rgKey } from "./filters";

export type CostPeriod = "mtd" | "lastMonth" | "30d" | "90d";
export const costPeriods: { id: CostPeriod; label: string }[] = [
  { id: "mtd", label: "Month to date" },
  { id: "lastMonth", label: "Last month" },
  { id: "30d", label: "Last 30 days" },
  { id: "90d", label: "Last 90 days" },
];
export const isCostPeriod = (v: unknown): v is CostPeriod => costPeriods.some((p) => p.id === v);

export interface CostData {
  period: CostPeriod;
  from: string; // YYYY-MM-DD (UTC)
  to: string;
  currency: string;
  fetchedAt: string;
  /** Cost by lower-cased resource id. */
  byResource: Record<string, number>;
  /** Total cost per subscription, including cost that has no resource id or no inventory row. */
  bySubscription: Record<string, number>;
  /** Subscriptions that could not be queried (e.g. missing Cost Management Reader). */
  warnings: string[];
  /** Subscriptions still being fetched in the background; poll again until 0. */
  pending?: number;
}

export interface CostBreakdownItem {
  serviceName: string;
  meter: string;
  cost: number;
}
export interface CostBreakdown {
  resourceId: string;
  period: CostPeriod;
  currency: string;
  items: CostBreakdownItem[];
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Inclusive UTC date range for a period. */
export function periodRange(period: CostPeriod, now = new Date()): { from: string; to: string } {
  const day = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d));
  const y = now.getUTCFullYear(), m = now.getUTCMonth(), d = now.getUTCDate();
  switch (period) {
    case "mtd": return { from: iso(day(y, m, 1)), to: iso(day(y, m, d)) };
    case "lastMonth": return { from: iso(day(y, m - 1, 1)), to: iso(day(y, m, 0)) };
    case "30d": return { from: iso(day(y, m, d - 29)), to: iso(day(y, m, d)) };
    case "90d": return { from: iso(day(y, m, d - 89)), to: iso(day(y, m, d)) };
  }
}

export interface CostRollup {
  resource: Map<string, number>; // keyed by Resource.id as stored in the inventory
  resourceGroup: Map<string, number>; // keyed by rgKey
  subscription: Map<string, number>; // full subscription total
  unallocated: Map<string, number>; // subscription total not attributable to an inventory resource
  total: number;
}

/** Roll resource costs up to resource group, subscription and tenant. Pass the unfiltered inventory. */
export function costRollup(resources: Resource[], cost: CostData): CostRollup {
  const out: CostRollup = {
    resource: new Map(), resourceGroup: new Map(), subscription: new Map(), unallocated: new Map(), total: 0,
  };
  const attributed = new Map<string, number>();
  for (const r of resources) {
    const c = cost.byResource[r.id.toLowerCase()];
    if (c === undefined) continue;
    out.resource.set(r.id, c);
    out.resourceGroup.set(rgKey(r), (out.resourceGroup.get(rgKey(r)) ?? 0) + c);
    attributed.set(r.subscriptionId, (attributed.get(r.subscriptionId) ?? 0) + c);
  }
  for (const [sub, total] of Object.entries(cost.bySubscription)) {
    out.subscription.set(sub, total);
    out.total += total;
    const rest = total - (attributed.get(sub) ?? 0);
    if (rest > 0.005) out.unallocated.set(sub, rest);
  }
  return out;
}

/** Only attributed spend of matching resources; omitted resources are not unallocated spend. */
export function matchingCostRollup(resources: Resource[], cost: CostData): CostRollup {
  const out: CostRollup = {
    resource: new Map(), resourceGroup: new Map(), subscription: new Map(), unallocated: new Map(), total: 0,
  };
  for (const r of resources) {
    const value = cost.byResource[r.id.toLowerCase()];
    if (value === undefined) continue;
    out.resource.set(r.id, value);
    out.resourceGroup.set(rgKey(r), (out.resourceGroup.get(rgKey(r)) ?? 0) + value);
    out.subscription.set(r.subscriptionId, (out.subscription.get(r.subscriptionId) ?? 0) + value);
    out.total += value;
  }
  return out;
}

export function formatCost(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency", currency, maximumFractionDigits: value >= 100 ? 0 : 2,
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}
