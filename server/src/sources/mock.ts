import {
  extractEdges, periodRange, type CostBreakdown, type CostData, type CostPeriod, type Resource,
} from "@azure-vision/shared";
import type { ResourceSource } from "./types";

const subs = [
  { id: "11111111-1111-1111-1111-111111111111", name: "Production" },
  { id: "22222222-2222-2222-2222-222222222222", name: "Development" },
];

const mk = (
  s: (typeof subs)[number], rg: string, type: string, name: string, properties: Record<string, unknown> = {},
  tags: Record<string, string> = {},
): Resource => ({
  id: `/subscriptions/${s.id}/resourceGroups/${rg}/providers/${type}/${name}`.toLowerCase(),
  name, type: type.toLowerCase(), subscriptionId: s.id, subscriptionName: s.name,
  resourceGroup: rg, location: "eastus", tags, properties,
});

function build(): Resource[] {
  const out: Resource[] = [];
  for (const s of subs) {
    const env = s.name === "Production" ? "prod" : "dev";
    for (const app of ["web", "data"]) {
      const rg = `rg-${app}-${env}`;
      const base = (t: string, n: string, p = {}) => mk(s, rg, t, n, p, { env });
      const vnet = base("Microsoft.Network/virtualNetworks", `vnet-${app}`);
      const nsg = base("Microsoft.Network/networkSecurityGroups", `nsg-${app}`);
      out.push(vnet, nsg);
      for (let i = 1; i <= 2; i++) {
        const disk = base("Microsoft.Compute/disks", `disk-${app}-${i}`);
        const nic = base("Microsoft.Network/networkInterfaces", `nic-${app}-${i}`, {
          ipConfigurations: [{ properties: { subnet: { id: `${vnet.id}/subnets/default` } } }],
          networkSecurityGroup: { id: nsg.id },
        });
        const vm = base("Microsoft.Compute/virtualMachines", `vm-${app}-${i}`, {
          networkProfile: { networkInterfaces: [{ id: nic.id }] },
          storageProfile: { osDisk: { managedDisk: { id: disk.id } } },
        });
        out.push(disk, nic, vm);
      }
      if (app === "web") {
        const plan = base("Microsoft.Web/serverfarms", "plan-web");
        out.push(plan, base("Microsoft.Web/sites", "app-frontend", { serverFarmId: plan.id }));
        out.push(base("Microsoft.Cache/Redis", "redis-cache"));
      } else {
        out.push(base("Microsoft.Sql/servers", "sql-server"), base("Microsoft.Storage/storageAccounts", "stdata"));
        out.push(base("Microsoft.KeyVault/vaults", "kv-data"));
      }
    }
  }
  // Hub and spoke: prod web VNet is the hub, the other three VNets are spokes.
  const vnets = out.filter((r) => r.type === "microsoft.network/virtualnetworks");
  vnets.forEach((v, i) => {
    v.properties = {
      addressSpace: { addressPrefixes: [`10.${i}.0.0/16`] },
      subnets: ["default", "app", "data"].map((name, j) => ({ name, properties: { addressPrefix: `10.${i}.${j}.0/24` } })),
    };
  });
  const hub = vnets[0];
  const peering = (remote: Resource) => ({ virtualNetworkPeerings: [{ properties: { remoteVirtualNetwork: { id: remote.id } } }] });
  for (const spoke of vnets.slice(1)) {
    const hp = hub.properties as any;
    hp.virtualNetworkPeerings = [...(hp.virtualNetworkPeerings ?? []), ...peering(spoke).virtualNetworkPeerings];
    spoke.properties = { ...spoke.properties, ...peering(hub) };
  }
  return out;
}

export const mockSource: ResourceSource = {
  async fetchInventory() {
    const resources = build();
    return { resources, edges: extractEdges(resources), fetchedAt: new Date().toISOString() };
  },
};

const PERIOD_FACTOR: Record<CostPeriod, number> = { mtd: 0.5, lastMonth: 1, "30d": 1, "90d": 3 };
const BASE_COST: Record<string, number> = {
  "microsoft.compute/virtualmachines": 140, "microsoft.compute/disks": 12, "microsoft.web/serverfarms": 75,
  "microsoft.sql/servers": 220, "microsoft.cache/redis": 90, "microsoft.storage/storageaccounts": 18,
  "microsoft.network/virtualnetworks": 0,
};
const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

/** Deterministic fixture costs: zero-cost types are omitted so the UI shows "no cost" resources too. */
export function mockCosts(resources: Resource[], period: CostPeriod): CostData {
  const { from, to } = periodRange(period);
  const byResource: Record<string, number> = {};
  const bySubscription: Record<string, number> = {};
  for (const r of resources) {
    const base = BASE_COST[r.type] ?? 0;
    if (!base) continue;
    const c = Math.round(base * (0.6 + (hash(r.id) % 80) / 100) * PERIOD_FACTOR[period] * 100) / 100;
    byResource[r.id.toLowerCase()] = c;
    bySubscription[r.subscriptionId] = (bySubscription[r.subscriptionId] ?? 0) + c;
  }
  for (const s of Object.keys(bySubscription)) bySubscription[s] += 12.34; // cost with no resource id
  return { period, from, to, currency: "USD", fetchedAt: new Date().toISOString(), byResource, bySubscription, warnings: [] };
}

export function mockBreakdown(resource: Resource, total: number, period: CostPeriod): CostBreakdown {
  const parts: [string, string, number][] = [
    [resource.type.split("/")[0].replace("microsoft.", ""), "Compute / base", 0.7],
    [resource.type.split("/")[0].replace("microsoft.", ""), "Data transfer / egress", 0.2],
    ["Bandwidth", "Standard data transfer out", 0.1],
  ];
  return {
    resourceId: resource.id, period, currency: "USD",
    items: parts.map(([serviceName, meter, f]) => ({ serviceName, meter, cost: Math.round(total * f * 100) / 100 })),
  };
}
