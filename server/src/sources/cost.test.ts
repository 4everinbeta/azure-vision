import { describe, expect, it, vi } from "vitest";
import { patient, queryBreakdown, querySubscriptionCost, type Http } from "./cost";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });
const page = (rows: unknown[][], nextLink?: string, columns = ["Cost", "ResourceId", "Currency"]) =>
  json({ properties: { columns: columns.map((name) => ({ name })), rows, nextLink } });

const now = new Date("2026-03-15T00:00:00Z");

const noSleep = { sleep: async () => {} };

describe("querySubscriptionCost", () => {
  it("sums per resource across pages, lower-casing ids and counting unattributed cost in the total", async () => {
    const calls: string[] = [];
    const pages = [
      page([[1.5, "/SUBSCRIPTIONS/s1/rg/VM1", "EUR"], [2, "", "EUR"]], "https://next/page2"),
      page([[3, "/subscriptions/s1/rg/vm1", "EUR"]]),
    ];
    const http: Http = { ...noSleep, fetch: (async (url: string) => { calls.push(url); return pages.shift()!; }) as unknown as typeof fetch };
    const r = await querySubscriptionCost("t", "s1", "mtd", http, now);
    expect(r.byResource).toEqual({ "/subscriptions/s1/rg/vm1": 4.5 });
    expect(r.total).toBe(6.5);
    expect(r.currency).toBe("EUR");
    expect(calls).toContain("https://next/page2");
  });

  it("retries throttled requests honoring Retry-After", async () => {
    const sleep = vi.fn(async () => {});
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({}, 429, { "retry-after": "7" }))
      .mockResolvedValueOnce(page([[1, "/subscriptions/s1/x", "USD"]]));
    const r = await querySubscriptionCost("t", "s1", "mtd", { sleep, fetch: fetchMock as unknown as typeof fetch }, now);
    expect(sleep).toHaveBeenCalledWith(7000);
    expect(r.total).toBe(1);
  });

  it("uses the longest rate-limit header, waiting for it only when patient", async () => {
    const throttled = () => json({}, 429, { "x-ms-ratelimit-microsoft.costmanagement-tenant-retry-after": "90", "retry-after": "5" });
    const sleep = vi.fn(async () => {});
    const mk = (...rs: Response[]) => ({ sleep, fetch: vi.fn().mockResolvedValueOnce(rs[0]).mockResolvedValueOnce(rs[1]) as unknown as typeof fetch });
    await expect(querySubscriptionCost("t", "s1", "mtd", mk(throttled(), page([])), now)).rejects.toThrow("429"); // 90s > interactive cap
    expect(sleep).not.toHaveBeenCalled();
    await querySubscriptionCost("t", "s1", "mtd", mk(throttled(), page([[1, "/subscriptions/s1/x", "USD"]])), now, patient);
    expect(sleep).toHaveBeenCalledWith(90_000);
  });

  it("fails with the service's message on other errors", async () => {
    const fetchMock = vi.fn(async () => json({ error: "denied" }, 403));
    await expect(querySubscriptionCost("t", "bad", "mtd", { ...noSleep, fetch: fetchMock as unknown as typeof fetch }, now)).rejects.toThrow("403");
  });
});

describe("queryBreakdown", () => {
  it("returns items sorted by cost and filters on the resource id", async () => {
    let sent: any;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      sent = JSON.parse(init.body as string);
      return page([[1, "Storage", "Hot LRS", "USD"], [9, "Virtual Machines", "D2s v3", "USD"]], undefined,
        ["Cost", "ServiceName", "Meter", "Currency"]);
    });
    const id = "/subscriptions/s1/resourceGroups/rg/providers/x/y/vm";
    const r = await queryBreakdown("t", id, "30d", { sleep: async () => {}, fetch: fetchMock as unknown as typeof fetch }, now);
    expect(r.items.map((i) => i.meter)).toEqual(["D2s v3", "Hot LRS"]);
    expect(sent.dataset.filter.dimensions.values).toEqual([id]);
    expect(sent.dataset.grouping.map((g: any) => g.name)).toEqual(["ServiceName", "Meter"]);
  });
});
