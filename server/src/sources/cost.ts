import { periodRange, type CostBreakdown, type CostPeriod } from "@azure-vision/shared";

const API = "2023-11-01";
const MAX_RETRIES = 4;
const MAX_WAIT_MS = 30_000;
const BREAKDOWN_LIMIT = 100;

export interface Http {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
}
const defaultHttp: Http = { fetch: (...a) => fetch(...a), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

interface QueryResult { columns: string[]; rows: unknown[][] }

export interface RetryPolicy { maxRetries: number; maxWaitMs: number }
const interactive: RetryPolicy = { maxRetries: MAX_RETRIES, maxWaitMs: MAX_WAIT_MS };
/** Background collection can afford to wait out the service's throttling window. */
export const patient: RetryPolicy = { maxRetries: 6, maxWaitMs: 180_000 };

/** Longest wait requested by Retry-After or any x-ms-ratelimit-*-retry-after header (seconds), if any. */
function retryAfterMs(res: Response): number | undefined {
  let best = 0;
  res.headers.forEach((v, k) => {
    if (k === "retry-after" || /^x-ms-ratelimit-.*retry-after$/.test(k)) {
      const n = Number(v);
      if (Number.isFinite(n) && n > best) best = n;
    }
  });
  return best > 0 ? best * 1000 : undefined;
}

/** POSTs a Cost Management query, following nextLink pages and backing off on throttling (429/503). */
async function costQuery(token: string, scope: string, body: unknown, http: Http, policy = interactive): Promise<QueryResult> {
  let url: string | undefined = `https://management.azure.com${scope}/providers/Microsoft.CostManagement/query?api-version=${API}`;
  let columns: string[] = [];
  const rows: unknown[][] = [];
  while (url) {
    let res: Response;
    for (let attempt = 0; ; attempt++) {
      res = await http.fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if ((res.status !== 429 && res.status !== 503) || attempt >= policy.maxRetries) break;
      const wait = retryAfterMs(res) ?? Math.min(2 ** attempt * 1000, policy.maxWaitMs);
      if (wait > policy.maxWaitMs) break;
      await http.sleep(wait);
    }
    if (!res.ok) throw new Error(`Cost Management ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json: any = await res.json();
    columns = (json.properties?.columns ?? []).map((c: { name: string }) => c.name);
    rows.push(...(json.properties?.rows ?? []));
    url = json.properties?.nextLink || undefined;
  }
  return { columns, rows };
}

const col = (r: QueryResult, name: string) => r.columns.findIndex((c) => c.toLowerCase() === name.toLowerCase());

const dataset = (grouping: string[], filter?: unknown) => ({
  granularity: "None",
  aggregation: { totalCost: { name: "Cost", function: "Sum" } },
  grouping: grouping.map((name) => ({ type: "Dimension", name })),
  ...(filter ? { filter } : {}),
});

const timePeriod = (period: CostPeriod, now: Date) => {
  const { from, to } = periodRange(period, now);
  return { from, to, body: { from: `${from}T00:00:00+00:00`, to: `${to}T23:59:59+00:00` } };
};

export interface SubscriptionCost { byResource: Record<string, number>; total: number; currency: string; fetchedAt: string }

/** Actual cost per resource for one subscription. */
export async function querySubscriptionCost(
  token: string, sub: string, period: CostPeriod, http: Http = defaultHttp, now = new Date(), policy = interactive,
): Promise<SubscriptionCost> {
  const range = timePeriod(period, now);
  const body = { type: "ActualCost", timeframe: "Custom", timePeriod: range.body, dataset: dataset(["ResourceId"]) };
  const r = await costQuery(token, `/subscriptions/${sub}`, body, http, policy);
  const cost = col(r, "Cost") >= 0 ? col(r, "Cost") : col(r, "PreTaxCost");
  const id = col(r, "ResourceId"), cur = col(r, "Currency");
  const out: SubscriptionCost = { byResource: {}, total: 0, currency: "USD", fetchedAt: new Date().toISOString() };
  let currencySeen = false;
  for (const row of r.rows) {
    const c = Number(row[cost]) || 0;
    out.total += c;
    const rid = String(row[id] ?? "").toLowerCase();
    if (rid) out.byResource[rid] = (out.byResource[rid] ?? 0) + c;
    if (cur >= 0 && !currencySeen && row[cur]) { out.currency = String(row[cur]); currencySeen = true; }
  }
  return out;
}

/** Cost of one resource split by service and meter, largest first. */
export async function queryBreakdown(
  token: string, resourceId: string, period: CostPeriod, http: Http = defaultHttp, now = new Date(),
): Promise<CostBreakdown> {
  const sub = /^\/subscriptions\/([^/]+)/i.exec(resourceId)?.[1];
  if (!sub) throw new Error("Invalid resource id");
  const range = timePeriod(period, now);
  const body = {
    type: "ActualCost", timeframe: "Custom", timePeriod: range.body,
    dataset: dataset(["ServiceName", "Meter"], { dimensions: { name: "ResourceId", operator: "In", values: [resourceId] } }),
  };
  const r = await costQuery(token, `/subscriptions/${sub}`, body, http);
  const cost = col(r, "Cost") >= 0 ? col(r, "Cost") : col(r, "PreTaxCost");
  const svc = col(r, "ServiceName"), meter = col(r, "Meter"), cur = col(r, "Currency");
  const items = r.rows
    .map((row) => ({ serviceName: String(row[svc] ?? ""), meter: String(row[meter] ?? ""), cost: Number(row[cost]) || 0 }))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, BREAKDOWN_LIMIT);
  return { resourceId, period, currency: cur >= 0 && r.rows[0] ? String(r.rows[0][cur]) : "USD", items };
}
