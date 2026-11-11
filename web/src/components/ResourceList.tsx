import { useMemo } from "react";
import { formatCost, resourceTypeLabel, type CostRollup, type Inventory, type Resource } from "@azure-vision/shared";
import { compareExplore, type SortPrefs } from "../exploreSort";

export function ResourceList({ inv, rollup, currency, sort, selectedId, onSelect }: {
  inv: Inventory; rollup?: CostRollup; currency?: string; sort: SortPrefs; selectedId?: string; onSelect: (resource: Resource) => void;
}) {
  const rows = useMemo(() => inv.resources.map((resource) => ({
    resource, id: resource.id, name: resource.name, type: resourceTypeLabel(resource.type),
    location: resource.location, spend: rollup?.resource.get(resource.id),
  })).sort((a, b) => compareExplore(a, b, sort)), [inv, rollup, sort]);
  return (
    <div className="resource-list">
      <table aria-label="Resources">
        <thead><tr><th>Name</th><th>Type</th><th>Location</th>{currency && <th>Spend</th>}</tr></thead>
        <tbody>{rows.map((row) => (
          <tr key={row.id} className={row.id === selectedId ? "selected" : ""}>
            <td><button className="link" onClick={() => onSelect(row.resource)}>{row.name}</button></td>
            <td title={row.resource.type}>{row.type}</td><td>{row.location || "Global"}</td>
            {currency && <td>{row.spend === undefined ? <span title="Cost data unavailable for this resource">Unavailable</span> : formatCost(row.spend, currency)}</td>}
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}
