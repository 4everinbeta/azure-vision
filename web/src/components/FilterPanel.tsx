import { applyFilters, rgKey, type Filters, type Inventory } from "@azure-vision/shared";
import { shortType } from "../icons";

interface Props {
  inv: Inventory;
  filters: Filters;
  onChange: (f: Filters) => void;
}

function MultiSelect({ title, options, selected, onChange }: {
  title: string;
  options: { value: string; label: string; count: number }[];
  selected: string[];
  onChange: (v: string[]) => void;
}) {
  const toggle = (v: string) => onChange(selected.includes(v) ? selected.filter((s) => s !== v) : [...selected, v]);
  return (
    <fieldset>
      <legend>
        {title} {selected.length > 0 && <button className="link" onClick={() => onChange([])}>clear</button>}
      </legend>
      <div className="options">
        {options.map((o) => (
          <label key={o.value}>
            <input type="checkbox" checked={selected.includes(o.value)} onChange={() => toggle(o.value)} />
            {o.label} <em>{o.count}</em>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function tally<T>(items: T[], key: (t: T) => string, label: (t: T) => string) {
  const m = new Map<string, { value: string; label: string; count: number }>();
  for (const i of items) {
    const k = key(i);
    const e = m.get(k) ?? { value: k, label: label(i), count: 0 };
    e.count++;
    m.set(k, e);
  }
  return [...m.values()].sort((a, b) => a.label.localeCompare(b.label));
}

type Facet = "subscriptions" | "resourceGroups" | "types";

// Resources matching every filter except the given facet, so each box only offers values that still apply.
const scopeFor = (inv: Inventory, f: Filters, facet: Facet) => applyFilters(inv, { ...f, [facet]: [] }).resources;

export function FilterPanel({ inv, filters, onChange }: Props) {
  const subScope = scopeFor(inv, filters, "subscriptions");
  const rgScope = scopeFor(inv, filters, "resourceGroups");
  const typeScope = scopeFor(inv, filters, "types");

  // Drop selections that are no longer available after a change in another box.
  const change = (next: Filters) => {
    const keep = (facet: Facet, key: (r: Inventory["resources"][number]) => string) => {
      const avail = new Set(scopeFor(inv, next, facet).map(key));
      return next[facet].filter((v) => avail.has(v));
    };
    onChange({
      ...next,
      subscriptions: keep("subscriptions", (r) => r.subscriptionId),
      resourceGroups: keep("resourceGroups", rgKey),
      types: keep("types", (r) => r.type),
    });
  };

  return (
    <aside className="filters">
      <input
        type="search" placeholder="Search name or type…" value={filters.search}
        onChange={(e) => change({ ...filters, search: e.target.value })}
      />
      <MultiSelect
        title="Subscription" selected={filters.subscriptions}
        options={tally(subScope, (r) => r.subscriptionId, (r) => r.subscriptionName ?? r.subscriptionId)}
        onChange={(subscriptions) => change({ ...filters, subscriptions })}
      />
      <MultiSelect
        title="Resource group" selected={filters.resourceGroups}
        options={tally(rgScope, rgKey, (r) => r.resourceGroup)}
        onChange={(resourceGroups) => change({ ...filters, resourceGroups })}
      />
      <MultiSelect
        title="Resource type" selected={filters.types}
        options={tally(typeScope, (r) => r.type, (r) => shortType(r.type))}
        onChange={(types) => change({ ...filters, types })}
      />
    </aside>
  );
}
