import { describe, expect, it } from "vitest";
import { applyFilters, emptyFilters, exploreFacets, extractEdges, filterExplore, type Inventory, type Resource } from "./index";

const mk = (name: string, type: string, sub: string, rg: string, properties = {}): Resource => ({
  id: `/subscriptions/${sub}/resourceGroups/${rg}/providers/${type}/${name}`,
  name, type, subscriptionId: sub, resourceGroup: rg, location: "eastus", tags: {}, properties,
});

describe("Explore filtering", () => {
  const aks = "microsoft.containerservice/managedclusters", bus = "microsoft.servicebus/namespaces";
  const resources = [mk("aks1", aks, "s1", "one"), mk("bus1", bus, "s1", "two"),
    mk("aks2", aks, "s2", "both"), mk("bus2", bus, "s2", "both"), other];
  const inventory: Inventory = { resources, edges: [], fetchedAt: "" };
  const filters = { ...emptyFilters, types: [aks, bus] };
  it("matches any type and friendly names, without changing Network search", () => {
    expect(filterExplore(inventory, filters, {}, "any").resources).toHaveLength(4);
    expect(filterExplore(inventory, { ...emptyFilters, search: "AKS" }, {}, "any").resources.map((r) => r.name)).toEqual(["aks1", "aks2"]);
    expect(applyFilters(inventory, { ...emptyFilters, search: "AKS" }).resources.map((r) => r.name)).toEqual(["aks1", "aks2"]);
    expect(filterExplore(inventory, { ...emptyFilters, search: "Kubernetes" }, {}, "any").resources).toHaveLength(2);
    expect(applyFilters(inventory, { ...emptyFilters, search: "Kubernetes" }).resources).toHaveLength(0);
  });
  it("requires all types per subscription, then per group when drilling down", () => {
    expect(filterExplore(inventory, filters, {}, "all").resources).toHaveLength(4);
    expect(filterExplore(inventory, filters, { sub: "s1" }, "all").resources).toHaveLength(0);
    expect(filterExplore(inventory, filters, { sub: "s2" }, "all").resources.map((r) => r.name)).toEqual(["aks2", "bus2"]);
    expect(filterExplore(inventory, filters, { sub: "s1", rg: "s1/one" }, "all").resources).toHaveLength(0);
  });
  it("applies group and text restrictions before All containment", () => {
    expect(filterExplore(inventory, { ...filters, resourceGroups: ["s1/one"] }, {}, "all").resources).toHaveLength(0);
    expect(filterExplore(inventory, { ...filters, search: "aks" }, {}, "all").resources).toHaveLength(0);
  });
  it("scopes dependent facets and retains unavailable explicit selections", () => {
    const f = { ...emptyFilters, types: [aks], resourceGroups: ["s1/one"] };
    const facets = exploreFacets(inventory, f, { sub: "s2" }, "any");
    expect(facets.resourceGroups.map((o) => [o.value, o.count])).toEqual([["s2/both", 1], ["s1/one", 0]]);
    expect(facets.types).toEqual([{ value: aks, label: "AKS (Azure Kubernetes Service)", count: 0 }]);
    expect(exploreFacets(inventory, { ...emptyFilters, subscriptions: ["s1"] }, {}, "any").resourceGroups.map((o) => o.value))
      .toEqual(["s1/one", "s1/two"]);
  });
  it("offers disjunctive OR alternatives but only possible All additions", () => {
    expect(exploreFacets(inventory, { ...emptyFilters, types: [aks] }, { sub: "s2" }, "any").types.map((o) => o.value))
      .toContain(other.type);
    expect(exploreFacets(inventory, { ...emptyFilters, types: [aks] }, { sub: "s2" }, "all").types.map((o) => o.value))
      .not.toContain(other.type);
  });
});

const nic = mk("nic1", "microsoft.network/networkinterfaces", "s1", "rg1");
const vm = mk("vm1", "microsoft.compute/virtualmachines", "s1", "rg1", {
  networkProfile: { networkInterfaces: [{ id: nic.id.toUpperCase() }] },
});
const other = mk("st1", "microsoft.storage/storageaccounts", "s2", "rg2");
const all = [vm, nic, other];
const inv: Inventory = { resources: all, edges: extractEdges(all), fetchedAt: "" };

describe("edges", () => {
  it("links VM to NIC case-insensitively", () => {
    expect(inv.edges).toHaveLength(1);
    expect(inv.edges[0]).toMatchObject({ source: vm.id, target: nic.id });
  });
});

describe("peering", () => {
  it("links peered VNets across subscriptions as a single edge", () => {
    const hub = mk("hub", "microsoft.network/virtualnetworks", "s1", "rg-hub");
    const spoke = mk("spoke", "microsoft.network/virtualnetworks", "s2", "rg-spoke");
    const peer = (remote: Resource) => ({ virtualNetworkPeerings: [{ properties: { remoteVirtualNetwork: { id: remote.id } } }] });
    hub.properties = peer(spoke);
    spoke.properties = peer(hub);
    const edges = extractEdges([hub, spoke]);
    expect(edges).toHaveLength(1);
    expect(edges[0].kind).toBe("peering");
  });
});

describe("filters", () => {
  it("filters by subscription and drops dangling edges", () => {
    const r = applyFilters(inv, { ...emptyFilters, subscriptions: ["s2"] });
    expect(r.resources).toEqual([other]);
    expect(r.edges).toHaveLength(0);
  });
  it("filters by type and search", () => {
    expect(applyFilters(inv, { ...emptyFilters, types: [vm.type] }).resources).toEqual([vm]);
    expect(applyFilters(inv, { ...emptyFilters, search: "NIC" }).resources).toEqual([nic]);
  });
  it("filters by resource group", () => {
    expect(applyFilters(inv, { ...emptyFilters, resourceGroups: ["s2/rg2"] }).resources).toEqual([other]);
  });
});
