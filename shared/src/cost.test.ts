import { describe, expect, it } from "vitest";
import { costRollup, matchingCostRollup, periodRange, type CostData, type Resource } from "./index";

const mk = (name: string, sub: string, rg: string): Resource => ({
  id: `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Compute/virtualMachines/${name}`,
  name, type: "microsoft.compute/virtualmachines", subscriptionId: sub, resourceGroup: rg, location: "eastus",
  tags: {}, properties: {},
});

describe("periodRange", () => {
  const now = new Date("2026-03-15T10:00:00Z");
  it("computes month to date and last month", () => {
    expect(periodRange("mtd", now)).toEqual({ from: "2026-03-01", to: "2026-03-15" });
    expect(periodRange("lastMonth", now)).toEqual({ from: "2026-02-01", to: "2026-02-28" });
  });
  it("computes rolling windows inclusive of today and across year boundaries", () => {
    expect(periodRange("30d", now)).toEqual({ from: "2026-02-14", to: "2026-03-15" });
    expect(periodRange("lastMonth", new Date("2026-01-10T00:00:00Z"))).toEqual({ from: "2025-12-01", to: "2025-12-31" });
  });
});

describe("costRollup", () => {
  const a = mk("a", "s1", "rg1"), b = mk("b", "s1", "rg1"), c = mk("c", "s1", "rg2");
  const cost: CostData = {
    period: "mtd", from: "", to: "", currency: "USD", fetchedAt: "", warnings: [],
    byResource: { [a.id.toLowerCase()]: 10, [b.id.toLowerCase()]: 5, [c.id.toLowerCase()]: 1 },
    bySubscription: { s1: 20, s2: 3 },
  };
  it("matches resource ids case-insensitively and sums per group and subscription", () => {
    const r = costRollup([a, b, c], cost);
    expect(r.resource.get(a.id)).toBe(10);
    expect(r.resourceGroup.get("s1/rg1")).toBe(15);
    expect(r.resourceGroup.get("s1/rg2")).toBe(1);
    expect(r.subscription.get("s1")).toBe(20);
    expect(r.total).toBe(23);
  });
  it("reports cost that is not attributable to an inventory resource as unallocated", () => {
    const r = costRollup([a, b, c], cost);
    expect(r.unallocated.get("s1")).toBe(4);
    expect(r.unallocated.get("s2")).toBe(3);
  });
  it("sums only matching spend without inventing unallocated costs", () => {
    const r = matchingCostRollup([a, c], cost);
    expect(r.subscription.get("s1")).toBe(11);
    expect(r.subscription.has("s2")).toBe(false);
    expect(r.total).toBe(11);
    expect(r.unallocated.size).toBe(0);
  });
  it("distinguishes missing cost from explicit zero and retains credits", () => {
    const missing = mk("missing", "s3", "rg3");
    const r = matchingCostRollup([a, b, missing], {
      ...cost, byResource: { [a.id.toLowerCase()]: 0, [b.id.toLowerCase()]: -5 },
    });
    expect(r.resource.get(a.id)).toBe(0);
    expect(r.resource.has(missing.id)).toBe(false);
    expect(r.subscription.has("s3")).toBe(false);
    expect(r.total).toBe(-5);
  });
});
