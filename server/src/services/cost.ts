import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from "fastify";
import { isCostPeriod, type CostBreakdown, type CostData, type CostPeriod, type Inventory } from "@azure-vision/shared";
import { config } from "../config";
import { type Access, resolveAccess } from "../access";
import { HttpError } from "../http";
import { mockBreakdown, mockCosts } from "../sources/mock";
import { patient, queryBreakdown, querySubscriptionCost } from "../sources/cost";
import { getManagedToken } from "../sources/managed";
import { getStore } from "../store";
import { indexCosts } from "../search";
import { CostCollection, type Collected } from "../costCollection";
import { periodRange } from "@azure-vision/shared";

/** The inventory comes from the inventory service when INVENTORY_URL is set, otherwise from this process. */
async function inventoryFor(access: Access, req: FastifyRequest, log: FastifyBaseLogger): Promise<Inventory> {
  if (!config.inventoryUrl) return (await import("./inventory")).loadInventory(access, false, log);
  const res = await fetch(`${config.inventoryUrl}/api/inventory`, {
    headers: access.token ? { authorization: `Bearer ${access.token}` } : {},
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const msg = ((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`;
    throw new HttpError(res.status === 401 ? 401 : 502, `Inventory service: ${msg}`);
  }
  return res.json() as Promise<Inventory>;
}

/** ARM token for Cost Management calls; mock needs none. */
async function costToken(access: Access): Promise<string | undefined> {
  if (config.source === "managed") return getManagedToken();
  if (config.source === "arg") throw new HttpError(501, "Costs are not supported in arg mode");
  return access.token;
}

const periodOf = (q: { period?: string }): CostPeriod => {
  const p = q.period ?? "mtd";
  if (!isCostPeriod(p)) throw new HttpError(400, "Invalid period");
  return p;
};

/** Merges the per-subscription collection into the API shape; `pending` tells the UI to poll again. */
function assemble(period: CostPeriod, subs: string[], c: Collected): CostData {
  const { from, to } = periodRange(period, new Date());
  const data: CostData = { period, from, to, currency: "USD", fetchedAt: new Date().toISOString(), byResource: {}, bySubscription: {}, warnings: [], pending: c.pending };
  let oldest: string | undefined;
  for (const sub of subs) {
    const r = c.have.get(sub);
    if (!r) continue;
    if (!Object.keys(data.bySubscription).length) data.currency = r.currency;
    for (const [id, v] of Object.entries(r.byResource)) data.byResource[id] = (data.byResource[id] ?? 0) + v;
    data.bySubscription[sub] = r.total;
    if (!oldest || r.fetchedAt < oldest) oldest = r.fetchedAt;
  }
  if (oldest) data.fetchedAt = oldest;
  for (const [sub, msg] of c.failures) data.warnings.push(`${sub}: ${msg}`);
  return data;
}

let collection: CostCollection | undefined;
async function getCollection(log: FastifyBaseLogger) {
  collection ??= new CostCollection({
    store: await getStore(),
    ttlMs: config.costCacheTtlMs,
    spacingMs: config.costSpacingMs,
    retryFailedAfterMs: 60_000,
    onError: (sub, e) => log.warn(`cost query for ${sub} failed: ${e.message}`),
    onDone: (scope, period, c) => {
      if (c.have.size) indexCosts(assemble(period as CostPeriod, [...c.have.keys()], c), scope, log);
    },
  });
  return collection;
}

// Per-resource breakdowns are fetched on demand and kept in memory only (they would bloat the persisted cache).
const breakdowns = new Map<string, { at: number; value: CostBreakdown }>();
const MAX_BREAKDOWNS = 500;

export function registerCost(app: FastifyInstance) {
  app.get("/api/costs", async (req, reply) => {
    const access = await resolveAccess(req, reply);
    if (!access) return;
    const q = req.query as { period?: string; refresh?: string };
    const period = periodOf(q);
    const inv = await inventoryFor(access, req, req.log);
    const subs = [...new Set(inv.resources.map((r) => r.subscriptionId))];
    const scope = access.cacheKey;
    let fetchSub: (sub: string) => Promise<import("../sources/cost").SubscriptionCost>;
    if (config.source === "mock") {
      const all = mockCosts(inv.resources, period);
      fetchSub = async (sub) => {
        const byResource = Object.fromEntries(Object.entries(all.byResource).filter(([id]) => id.startsWith(`/subscriptions/${sub}/`)));
        return { byResource, total: all.bySubscription[sub] ?? 0, currency: all.currency, fetchedAt: new Date().toISOString() };
      };
    } else {
      const token = (await costToken(access))!;
      fetchSub = (sub) => querySubscriptionCost(token, sub, period, undefined, undefined, patient);
    }
    const collected = await (await getCollection(req.log)).request(scope, period, subs, fetchSub, q.refresh === "1");
    return assemble(period, subs, collected);
  });

  app.get("/api/costs/breakdown", async (req, reply) => {
    const access = await resolveAccess(req, reply);
    if (!access) return;
    const q = req.query as { period?: string; resourceId?: string; refresh?: string };
    const period = periodOf(q);
    if (!q.resourceId) throw new HttpError(400, "resourceId is required");
    const key = `${access.cacheKey}|${period}|${q.resourceId.toLowerCase()}`;
    const hit = breakdowns.get(key);
    if (q.refresh !== "1" && hit && Date.now() - hit.at < config.costCacheTtlMs) return hit.value;
    let value: CostBreakdown;
    if (config.source === "mock") {
      const inv = await inventoryFor(access, req, req.log);
      const res = inv.resources.find((r) => r.id.toLowerCase() === q.resourceId!.toLowerCase());
      if (!res) throw new HttpError(404, "Unknown resource");
      value = mockBreakdown(res, mockCosts(inv.resources, period).byResource[res.id.toLowerCase()] ?? 0, period);
    } else {
      try {
        value = await queryBreakdown((await costToken(access))!, q.resourceId, period);
      } catch (e) {
        if (e instanceof HttpError) throw e;
        req.log.error(e);
        throw new HttpError(502, (e as Error).message);
      }
    }
    if (breakdowns.size >= MAX_BREAKDOWNS) breakdowns.delete(breakdowns.keys().next().value!);
    breakdowns.set(key, { at: Date.now(), value });
    return value;
  });
}
