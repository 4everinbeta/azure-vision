import { describe, expect, it } from "vitest";
import { extractEdges, groupChildren, roleOf, type Resource } from "./index";

const mk = (name: string, type: string, properties = {}): Resource => ({
  id: `/subscriptions/s/resourcegroups/rg/providers/${type}/${name}`, name, type,
  subscriptionId: "s", resourceGroup: "rg", location: "eastus", tags: {}, properties,
});
const pip = mk("pip", "microsoft.network/publicipaddresses");
const nsg = mk("nsg", "microsoft.network/networksecuritygroups");
const disk = mk("disk", "microsoft.compute/disks");
const nic = mk("nic", "microsoft.network/networkinterfaces", {
  ipConfigurations: [{ properties: { publicIPAddress: { id: pip.id } } }], networkSecurityGroup: { id: nsg.id },
});
const vm = mk("vm", "microsoft.compute/virtualmachines", {
  networkProfile: { networkInterfaces: [{ id: nic.id }] }, storageProfile: { osDisk: { managedDisk: { id: disk.id } } },
});
const orphan = mk("orphan", "microsoft.compute/disks");
const all = [vm, nic, disk, pip, nsg, orphan];

describe("groupChildren", () => {
  const g = groupChildren(all, extractEdges(all));
  it("folds NIC, disk and the NIC's public IP into the VM, keeping orphans standalone", () => {
    expect(g.primary.map((r) => r.name).sort()).toEqual(["nsg", "orphan", "vm"]);
    expect(g.children.get(vm.id)?.map((r) => r.name).sort()).toEqual(["disk", "nic", "pip"]);
  });
  it("re-points edges at the owning card", () => {
    expect(g.edges.map((e) => `${e.source}>${e.target}`)).toEqual([`${vm.id}>${nsg.id}`]);
  });
});

describe("roleOf", () => {
  it("classifies common types and falls back to other", () => {
    expect(roleOf("microsoft.sql/servers")).toBe("data");
    expect(roleOf("microsoft.network/networksecuritygroups")).toBe("security");
    expect(roleOf("microsoft.network/virtualnetworks")).toBe("network");
    expect(roleOf("microsoft.foo/bar")).toBe("other");
  });
});
