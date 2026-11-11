import type { Edge, Resource } from "./types";

export type Role = "edge" | "network" | "compute" | "data" | "security" | "ops" | "other";
/** Left-to-right order used by diagram layouts. */
export const roleOrder: Role[] = ["edge", "network", "compute", "data", "security", "ops", "other"];
export const roleLabels: Record<Role, string> = {
  edge: "Edge", network: "Network", compute: "Compute", data: "Data", security: "Security", ops: "Operations", other: "Other",
};

const byProvider: [RegExp, Role][] = [
  [/^microsoft\.(cdn|network\/(frontdoors|applicationgateways|trafficmanagerprofiles|dnszones|publicipaddresses|azurefirewalls)|apimanagement)/, "edge"],
  [/^microsoft\.network\/(networksecuritygroups|applicationsecuritygroups|ddos)/, "security"],
  [/^microsoft\.(keyvault|managedidentity|security|authorization)/, "security"],
  [/^microsoft\.network/, "network"],
  [/^microsoft\.(compute|web|containerservice|containerinstance|app|batch|servicefabric|desktopvirtualization)/, "compute"],
  [/^microsoft\.(sql|storage|cache|documentdb|dbfor|datafactory|synapse|eventhub|servicebus|search|cosmosdb)/, "data"],
  [/^microsoft\.(insights|operationalinsights|operationsmanagement|automation|alertsmanagement|monitor|recoveryservices)/, "ops"],
];

export const roleOf = (type: string): Role => byProvider.find(([re]) => re.test(type))?.[1] ?? "other";

/** Types folded into the resource that references them, shown as badges instead of separate cards. */
export const collapsibleTypes = new Set([
  "microsoft.network/networkinterfaces",
  "microsoft.compute/disks",
  "microsoft.network/publicipaddresses",
]);

export interface Grouped {
  /** Resources drawn as cards. */
  primary: Resource[];
  /** Folded resources by the id of the card that owns them. */
  children: Map<string, Resource[]>;
  /** Edges between cards (endpoints re-pointed at owning cards, self-links and duplicates dropped). */
  edges: Edge[];
}

/** Folds NICs, disks and public IPs into the VM (or other resource) that references them. */
export function groupChildren(resources: Resource[], edges: Edge[]): Grouped {
  const byId = new Map(resources.map((r) => [r.id, r]));
  const parent = new Map<string, string>();
  for (const e of edges) {
    const t = byId.get(e.target);
    const s = byId.get(e.source);
    if (!t || !s || !collapsibleTypes.has(t.type) || parent.has(t.id)) continue;
    parent.set(t.id, s.id);
  }
  const rootOf = (id: string): string => {
    const seen = new Set<string>();
    while (parent.has(id) && !seen.has(id)) { seen.add(id); id = parent.get(id)!; }
    return seen.has(id) ? "" : id; // "" = cycle: leave the resource standalone
  };
  const children = new Map<string, Resource[]>();
  const folded = new Set<string>();
  for (const r of resources) {
    if (!parent.has(r.id)) continue;
    const root = rootOf(r.id);
    if (!root || root === r.id) continue;
    folded.add(r.id);
    children.set(root, [...(children.get(root) ?? []), r]);
  }
  const owner = (id: string) => (folded.has(id) ? rootOf(id) : id);
  const out = new Map<string, Edge>();
  for (const e of edges) {
    const source = owner(e.source), target = owner(e.target);
    if (source === target) continue;
    const id = e.kind === "peering" ? e.id : `${source}->${target}:${e.kind}`;
    if (!out.has(id)) out.set(id, { id, source, target, kind: e.kind });
  }
  return { primary: resources.filter((r) => !folded.has(r.id)), children, edges: [...out.values()] };
}
