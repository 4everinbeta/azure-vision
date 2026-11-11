export interface Resource {
  id: string;
  name: string;
  type: string; // lower-case ARM type, e.g. microsoft.compute/virtualmachines
  subscriptionId: string;
  subscriptionName?: string;
  resourceGroup: string;
  location: string;
  kind?: string;
  tags: Record<string, string>;
  properties: Record<string, unknown>;
}

export interface Edge {
  id: string;
  source: string; // resource id
  target: string; // resource id
  kind: string; // e.g. "uses-nic", "in-subnet"
}

export interface Inventory {
  resources: Resource[];
  edges: Edge[];
  fetchedAt: string;
}

export interface Filters {
  subscriptions: string[]; // empty = all
  resourceGroups: string[]; // "subscriptionId/resourceGroup", lower-case
  types: string[];
  search: string;
}

// Analysis hooks (post-MVP): misconfiguration, underuse, cost/perf/best-practice.
export type Severity = "info" | "low" | "medium" | "high" | "critical";
export interface Finding {
  ruleId: string;
  category: "security" | "cost" | "performance" | "reliability" | "operations";
  severity: Severity;
  resourceId: string;
  title: string;
  recommendation?: string;
}
export interface Rule {
  id: string;
  evaluate(inventory: Inventory): Finding[];
}
