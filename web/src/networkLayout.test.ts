import { describe, expect, it } from "vitest";
import { extractEdges, type Resource } from "@azure-vision/shared";
import { layoutNetwork } from "./networkLayout";

const vnet = (name: string, sub: string, peers: Resource[] = []): Resource => ({
  id: `/subscriptions/${sub}/resourcegroups/rg/providers/microsoft.network/virtualnetworks/${name}`,
  name, type: "microsoft.network/virtualnetworks", subscriptionId: sub, resourceGroup: "rg", location: "eastus", tags: {},
  properties: { virtualNetworkPeerings: peers.map((p) => ({ properties: { remoteVirtualNetwork: { id: p.id } } })) },
});

describe("layoutNetwork", () => {
  it("puts the most-connected VNet at the centre and isolated VNets below", () => {
    const s1 = vnet("spoke1", "b"), s2 = vnet("spoke2", "c"), lone = vnet("lone", "a");
    const hub = vnet("hub", "a", [s1, s2]);
    s1.properties = vnet("x", "b", [hub]).properties;
    s2.properties = vnet("x", "c", [hub]).properties;
    const resources = [hub, s1, s2, lone];
    const { nodes, edges, legend } = layoutNetwork({ resources, edges: extractEdges(resources), fetchedAt: "" });
    const pos = (n: string) => nodes.find((x) => x.id.endsWith(`/${n}`))!.position;
    expect(edges).toHaveLength(2);
    expect(legend).toHaveLength(3);
    expect(pos("hub").y).toBeGreaterThan(pos("spoke1").y); // spoke1 sits at the top of the ring
    expect(pos("lone").y).toBeGreaterThan(pos("hub").y);
  });
});
