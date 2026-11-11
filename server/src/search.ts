import type { FastifyBaseLogger } from "fastify";
import { roleOf, type CostData, type Inventory } from "@azure-vision/shared";
import { config } from "./config";

export const RESOURCE_INDEX = "azure-vision-resources";
export const COST_INDEX = "azure-vision-costs";
export const searchEnabled = () => !!config.elasticUrl;

async function es(path: string, init: { method?: string; body?: unknown; ndjson?: string } = {}) {
  const res = await fetch(`${config.elasticUrl}${path}`, {
    method: init.method ?? (init.body || init.ndjson ? "POST" : "GET"),
    headers: { "content-type": init.ndjson !== undefined ? "application/x-ndjson" : "application/json" },
    body: init.ndjson ?? (init.body ? JSON.stringify(init.body) : undefined),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Elasticsearch ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<any>;
}

async function bulk(index: string, docs: { id: string; doc: object }[]) {
  for (let i = 0; i < docs.length; i += 1000) {
    const lines = docs.slice(i, i + 1000).flatMap((d) => [JSON.stringify({ index: { _index: index, _id: d.id } }), JSON.stringify(d.doc)]);
    const r = await es("/_bulk", { ndjson: lines.join("\n") + "\n" });
    if (r.errors) throw new Error("Elasticsearch bulk indexing reported item errors");
  }
}

/** Indexing is best-effort: failures are logged and never fail the API call that triggered them. */
export function indexInventory(inv: Inventory, owner: string, log: FastifyBaseLogger) {
  if (!searchEnabled()) return;
  const docs = inv.resources.map((r) => ({
    id: `${owner}|${r.id.toLowerCase()}`,
    doc: {
      owner, resourceId: r.id, name: r.name, type: r.type, role: roleOf(r.type), subscriptionId: r.subscriptionId,
      subscriptionName: r.subscriptionName, resourceGroup: r.resourceGroup, location: r.location,
      tags: Object.entries(r.tags).map(([k, v]) => `${k}=${v}`), fetchedAt: inv.fetchedAt,
    },
  }));
  bulk(RESOURCE_INDEX, docs).catch((e) => log.warn(`inventory indexing failed: ${(e as Error).message}`));
}

export function indexCosts(data: CostData, owner: string, log: FastifyBaseLogger) {
  if (!searchEnabled()) return;
  const docs = Object.entries(data.byResource).map(([resourceId, cost]) => ({
    id: `${owner}|${data.period}|${resourceId}`,
    doc: { owner, resourceId, cost, currency: data.currency, period: data.period, from: data.from, to: data.to, fetchedAt: data.fetchedAt },
  }));
  bulk(COST_INDEX, docs).catch((e) => log.warn(`cost indexing failed: ${(e as Error).message}`));
}

export async function searchResources(owner: string, q: string, size = 50) {
  const r = await es(`/${RESOURCE_INDEX}/_search`, {
    body: {
      size,
      query: {
        bool: {
          filter: [{ term: { "owner.keyword": owner } }],
          must: q
            ? [{ simple_query_string: { query: q, fields: ["name^3", "type", "resourceGroup", "subscriptionName", "location", "tags", "role"], default_operator: "and" } }]
            : [{ match_all: {} }],
        },
      },
    },
  });
  return { total: r.hits.total.value as number, hits: r.hits.hits.map((h: any) => h._source) };
}
