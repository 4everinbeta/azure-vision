import type { Filters, Inventory, Resource } from "./types";

export const emptyFilters: Filters = { subscriptions: [], resourceGroups: [], types: [], search: "" };

export const rgKey = (r: Resource) => `${r.subscriptionId}/${r.resourceGroup}`.toLowerCase();

export function applyFilters(inv: Inventory, f: Filters): Inventory {
  const q = f.search.trim().toLowerCase();
  const resources = inv.resources.filter(
    (r) =>
      (!f.subscriptions.length || f.subscriptions.includes(r.subscriptionId)) &&
      (!f.resourceGroups.length || f.resourceGroups.includes(rgKey(r))) &&
      (!f.types.length || f.types.includes(r.type)) &&
      (!q || r.name.toLowerCase().includes(q) || r.type.includes(q)),
  );
  const ids = new Set(resources.map((r) => r.id));
  return { ...inv, resources, edges: inv.edges.filter((e) => ids.has(e.source) && ids.has(e.target)) };
}

export type TypeMatch = "any" | "all";
export interface ExploreScope { sub?: string; rg?: string }
export type FilterFacet = "subscriptions" | "resourceGroups" | "types";
export interface FacetOption { value: string; label: string; count: number }

const typeLabels: Record<string, string> = {
  "microsoft.containerservice/managedclusters": "AKS (Azure Kubernetes Service)",
  "microsoft.servicebus/namespaces": "Service Bus",
  "microsoft.compute/virtualmachines": "Virtual machines (VM)",
  "microsoft.compute/disks": "Managed disks",
  "microsoft.storage/storageaccounts": "Storage accounts",
  "microsoft.network/virtualnetworks": "Virtual networks (VNet)",
  "microsoft.network/networkinterfaces": "Network interfaces (NIC)",
  "microsoft.network/networksecuritygroups": "Network security groups (NSG)",
  "microsoft.network/publicipaddresses": "Public IP addresses",
  "microsoft.network/privateendpoints": "Private endpoints",
  "microsoft.web/sites": "App Service / Function apps",
  "microsoft.web/serverfarms": "App Service plans",
  "microsoft.sql/servers": "SQL servers",
  "microsoft.sql/servers/databases": "SQL databases",
  "microsoft.cache/redis": "Azure Cache for Redis",
  "microsoft.keyvault/vaults": "Key Vault",
};

export const resourceTypeLabel = (type: string): string => typeLabels[type] ?? (type.split("/").slice(1).join("/") || type);

const subset = (inv: Inventory, resources: Resource[]): Inventory => {
  const ids = new Set(resources.map((r) => r.id));
  return { ...inv, resources, edges: inv.edges.filter((e) => ids.has(e.source) && ids.has(e.target)) };
};

/** All-type containment is evaluated at the level represented by the current cards. */
export function filterExplore(inv: Inventory, f: Filters, scope: ExploreScope, match: TypeMatch): Inventory {
  const q = f.search.trim().toLowerCase();
  const base = inv.resources.filter((r) =>
    (!scope.sub || r.subscriptionId === scope.sub) &&
    (!scope.rg || rgKey(r) === scope.rg) &&
    (!f.subscriptions.length || f.subscriptions.includes(r.subscriptionId)) &&
    (!f.resourceGroups.length || f.resourceGroups.includes(rgKey(r))) &&
    (!q || r.name.toLowerCase().includes(q) || r.type.includes(q) || resourceTypeLabel(r.type).toLowerCase().includes(q)),
  );
  if (!f.types.length) return subset(inv, base);
  const selected = new Set(f.types);
  if (match === "any") return subset(inv, base.filter((r) => selected.has(r.type)));
  const key = (r: Resource) => scope.sub || scope.rg ? rgKey(r) : r.subscriptionId;
  const contents = new Map<string, Set<string>>();
  for (const r of base) {
    if (!selected.has(r.type)) continue;
    const types = contents.get(key(r)) ?? new Set<string>();
    types.add(r.type);
    contents.set(key(r), types);
  }
  return subset(inv, base.filter((r) => selected.has(r.type) && contents.get(key(r))?.size === selected.size));
}

/** Exclude each facet's own selection so alternative choices remain available. */
export function exploreFacets(inv: Inventory, f: Filters, scope: ExploreScope, match: TypeMatch): Record<FilterFacet, FacetOption[]> {
  const keys = {
    subscriptions: (r: Resource) => r.subscriptionId,
    resourceGroups: rgKey,
    types: (r: Resource) => r.type,
  };
  const labels = {
    subscriptions: (r: Resource) => r.subscriptionName ?? r.subscriptionId,
    resourceGroups: (r: Resource) => `${r.resourceGroup} (${r.subscriptionName ?? r.subscriptionId})`,
    types: (r: Resource) => resourceTypeLabel(r.type),
  };
  const options = (facet: FilterFacet): FacetOption[] => {
    let resources = filterExplore(inv, { ...f, [facet]: [] }, scope, match).resources;
    if (facet === "types" && match === "all" && f.types.length) {
      const qualifying = filterExplore(inv, f, scope, match).resources;
      const containerKey = (r: Resource) => scope.sub || scope.rg ? rgKey(r) : r.subscriptionId;
      const containers = new Set(qualifying.map(containerKey));
      resources = resources.filter((r) => containers.has(containerKey(r)));
    }
    const entries = new Map<string, FacetOption>();
    for (const r of resources) {
      const value = keys[facet](r);
      const entry = entries.get(value) ?? { value, label: labels[facet](r), count: 0 };
      entry.count++;
      entries.set(value, entry);
    }
    // Explicit choices remain clearable, even after navigation makes them unavailable.
    for (const value of f[facet]) {
      if (entries.has(value)) continue;
      const r = inv.resources.find((r) => keys[facet](r) === value);
      entries.set(value, { value, label: r ? labels[facet](r) : value, count: 0 });
    }
    return [...entries.values()].sort((a, b) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value));
  };
  return { subscriptions: options("subscriptions"), resourceGroups: options("resourceGroups"), types: options("types") };
}
