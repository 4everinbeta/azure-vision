import { describe, expect, it, vi } from "vitest";
import { CostCollection } from "./costCollection";
import type { SubscriptionCost } from "./sources/cost";
import type { KeyValueStore } from "./store/types";

const memStore = (): KeyValueStore => {
  const m = new Map<string, { at: number; v: unknown }>();
  return {
    get: async (k, ttl) => { const e = m.get(k); return e && Date.now() - e.at < ttl ? (e.v as never) : undefined; },
    put: async (k, v) => { m.set(k, { at: Date.now(), v }); },
  };
};
const cost = (total: number): SubscriptionCost => ({ byResource: {}, total, currency: "USD", fetchedAt: "t" });
const settle = () => new Promise((r) => setTimeout(r, 5));

describe("CostCollection", () => {
  const make = (over = {}) => {
    const sleep = vi.fn(async () => {});
    let t = 0;
    const c = new CostCollection({ store: memStore(), ttlMs: 1000, spacingMs: 50, retryFailedAfterMs: 60, sleep, now: () => t, ...over });
    return { c, sleep, advance: (ms: number) => { t += ms; } };
  };

  it("fetches subscriptions one at a time with spacing, serving partial data while pending", async () => {
    const { c, sleep } = make();
    const order: string[] = [];
    let active = 0, maxActive = 0;
    const fetchSub = async (s: string) => { order.push(s); maxActive = Math.max(maxActive, ++active); await settle(); active--; return cost(order.length); };
    const first = await c.request("u", "mtd", ["a", "b", "c"], fetchSub);
    expect(first.have.size).toBe(0);
    expect(first.pending).toBe(3);
    await new Promise((r) => setTimeout(r, 60));
    const done = await c.request("u", "mtd", ["a", "b", "c"], fetchSub);
    expect(done.pending).toBe(0);
    expect([...done.have.keys()].sort()).toEqual(["a", "b", "c"]);
    expect(order).toEqual(["a", "b", "c"]);
    expect(maxActive).toBe(1);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("serves cached data without refetching, and refetches everything on refresh", async () => {
    const { c } = make();
    const fetchSub = vi.fn(async () => cost(1));
    await c.request("u", "mtd", ["a"], fetchSub);
    await settle();
    await c.request("u", "mtd", ["a"], fetchSub);
    expect(fetchSub).toHaveBeenCalledTimes(1);
    const stale = await c.request("u", "mtd", ["a"], fetchSub, true);
    expect(stale.have.has("a")).toBe(true); // old value still served during the refresh
    await settle();
    expect(fetchSub).toHaveBeenCalledTimes(2);
  });

  it("records failures, keeps going, and retries them only after the cooldown", async () => {
    const { c, advance } = make();
    const fetchSub = vi.fn(async (s: string) => { if (s === "a") throw new Error("429"); return cost(1); });
    await c.request("u", "mtd", ["a", "b"], fetchSub);
    await settle();
    const r = await c.request("u", "mtd", ["a", "b"], fetchSub);
    expect(r.failures.get("a")).toBe("429");
    expect(r.have.has("b")).toBe(true);
    expect(fetchSub).toHaveBeenCalledTimes(2); // no immediate retry
    advance(100);
    await c.request("u", "mtd", ["a", "b"], fetchSub);
    await settle();
    expect(fetchSub).toHaveBeenCalledTimes(3);
  });
});
