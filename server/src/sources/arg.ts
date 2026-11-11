import { OnBehalfOfCredential } from "@azure/identity";
import { extractEdges, type Inventory, type Resource } from "@azure-vision/shared";
import { config } from "../config";
import type { ResourceSource } from "./types";

export const ARM_SCOPE = "https://management.azure.com/.default";
const ARG_URL = "https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2021-03-01";

async function argQuery(token: string, query: string): Promise<any[]> {
  const rows: any[] = [];
  let skipToken: string | undefined;
  do {
    const res = await fetch(ARG_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, options: { $top: 1000, $skipToken: skipToken, resultFormat: "objectArray" } }),
    });
    if (!res.ok) throw new Error(`Resource Graph ${res.status}: ${await res.text()}`);
    const body: any = await res.json();
    rows.push(...body.data);
    skipToken = body.$skipToken;
  } while (skipToken);
  return rows;
}

export async function queryInventory(token: string): Promise<Inventory> {
  {
    // Resource Graph returns every subscription the token's user can read.
    const [rows, subRows] = await Promise.all([
      argQuery(token, "Resources | project id, name, type, subscriptionId, resourceGroup, location, kind, tags, properties"),
      argQuery(token, "ResourceContainers | where type =~ 'microsoft.resources/subscriptions' | project subscriptionId, name"),
    ]);
    const subNames = new Map<string, string>(subRows.map((s) => [s.subscriptionId, s.name]));
    const resources: Resource[] = rows.map((r) => ({
      id: r.id,
      name: r.name,
      type: String(r.type).toLowerCase(),
      subscriptionId: r.subscriptionId,
      subscriptionName: subNames.get(r.subscriptionId),
      resourceGroup: String(r.resourceGroup).toLowerCase(),
      location: r.location,
      kind: r.kind || undefined,
      tags: r.tags ?? {},
      properties: r.properties ?? {},
    }));
    return { resources, edges: extractEdges(resources), fetchedAt: new Date().toISOString() };
  }
}

export const argSource: ResourceSource = {
  async fetchInventory(userToken) {
    if (!userToken) throw new Error("Missing user token");
    const cred = new OnBehalfOfCredential({
      tenantId: config.tenantId,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      userAssertionToken: userToken,
    });
    return queryInventory((await cred.getToken(ARM_SCOPE)).token);
  },
};
