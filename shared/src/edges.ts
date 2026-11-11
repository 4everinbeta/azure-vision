import type { Edge, Resource } from "./types";

type Extractor = (r: Resource) => Array<{ target?: string; kind: string }>;

const p = (r: Resource) => r.properties as any;
const arr = (v: any): any[] => (Array.isArray(v) ? v : []);

// Register new extractors here; keyed by lower-case resource type.
export const extractors: Record<string, Extractor> = {
  "microsoft.compute/virtualmachines": (r) => [
    ...arr(p(r).networkProfile?.networkInterfaces).map((n) => ({ target: n.id, kind: "uses-nic" })),
    ...arr(p(r).storageProfile?.dataDisks).map((d) => ({ target: d.managedDisk?.id, kind: "uses-disk" })),
    { target: p(r).storageProfile?.osDisk?.managedDisk?.id, kind: "uses-disk" },
  ],
  "microsoft.network/networkinterfaces": (r) => [
    ...arr(p(r).ipConfigurations).flatMap((c) => [
      { target: c.properties?.subnet?.id, kind: "in-subnet" },
      { target: c.properties?.publicIPAddress?.id, kind: "uses-public-ip" },
    ]),
    { target: p(r).networkSecurityGroup?.id, kind: "secured-by" },
  ],
  "microsoft.network/privateendpoints": (r) => [
    { target: p(r).subnet?.id, kind: "in-subnet" },
    ...arr(p(r).privateLinkServiceConnections).map((c) => ({
      target: c.properties?.privateLinkServiceId,
      kind: "private-link",
    })),
  ],
  "microsoft.network/virtualnetworks": (r) =>
    arr(p(r).virtualNetworkPeerings).map((x) => ({ target: x.properties?.remoteVirtualNetwork?.id, kind: "peering" })),
  "microsoft.web/sites": (r) => [{ target: p(r).serverFarmId, kind: "hosted-on" }],
};

const subnetToVnet = (id: string) => id.replace(/\/subnets\/[^/]+$/i, "");

export function extractEdges(resources: Resource[]): Edge[] {
  const byId = new Map(resources.map((r) => [r.id.toLowerCase(), r]));
  const edges = new Map<string, Edge>();
  for (const r of resources) {
    const ex = extractors[r.type];
    if (!ex) continue;
    for (const { target, kind } of ex(r)) {
      if (!target) continue;
      // Subnets are not top-level resources; link to their VNet.
      const t = byId.get(target.toLowerCase()) ?? byId.get(subnetToVnet(target).toLowerCase());
      if (!t || t.id === r.id) continue;
      // Peerings exist on both VNets; collapse the pair into one undirected edge.
      const id = kind === "peering" ? `peering:${[r.id, t.id].sort().join("<->")}` : `${r.id}->${t.id}:${kind}`;
      if (edges.has(id)) continue;
      edges.set(id, { id, source: r.id, target: t.id, kind });
    }
  }
  return [...edges.values()];
}
