import { useEffect, useId, useRef, useState } from "react";
import { type FacetOption, type FilterFacet, type Filters, type TypeMatch } from "@azure-vision/shared";
import { type SortKey, type SortPrefs } from "../exploreSort";

function FacetSelect({ title, options, selected, onChange }: {
  title: string; options: FacetOption[]; selected: string[]; onChange: (selected: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const visible = options.filter((o) => `${o.label} ${o.value}`.toLowerCase().includes(search.trim().toLowerCase()));
  const toggle = (value: string) => onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  return (
    <div className="facet-select" ref={root} onKeyDown={(event) => {
      if (event.key === "Escape" && open) { setOpen(false); trigger.current?.focus(); event.stopPropagation(); }
    }} onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }}>
      <button ref={trigger} type="button" aria-expanded={open} aria-controls={id}
        onClick={() => { setOpen(!open); setSearch(""); }}>
        {title} <span className="chip">{selected.length || "All"}</span>
      </button>
      {open && (
        <div id={id} className="facet-popover" role="group" aria-label={title}>
          <input ref={input} type="search" aria-label={`Find ${title.toLowerCase()}`} placeholder={`Find ${title.toLowerCase()}...`}
            value={search} onChange={(e) => setSearch(e.target.value)} />
          <div className="facet-options">
            {visible.map((o) => <label key={o.value} title={o.value}>
              <input type="checkbox" checked={selected.includes(o.value)} onChange={() => toggle(o.value)} />
              <span>{o.label}{!o.count && <small>Unavailable in current scope</small>}</span>
              <em>{o.count}</em>
            </label>)}
            {!visible.length && <p className="note">No available options.</p>}
          </div>
          {!!selected.length && <button className="link" onClick={() => onChange([])}>Clear {title.toLowerCase()}</button>}
        </div>
      )}
    </div>
  );
}

export function SortControl({ value, onChange, resourceList, costsEnabled }: {
  value: SortPrefs; onChange: (value: SortPrefs) => void; resourceList: boolean; costsEnabled: boolean;
}) {
  const options: { key: SortKey; label: string }[] = resourceList
    ? [{ key: "name", label: "Name" }, { key: "spend", label: "Spend" }, { key: "type", label: "Type" }, { key: "location", label: "Location" }]
    : [{ key: "name", label: "Name" }, { key: "spend", label: "Spend" }, { key: "count", label: "Resource count" }];
  return (
    <div className="sort-control">
      <label>Sort by <select aria-label="Sort by" value={!costsEnabled && value.key === "spend" ? "name" : value.key}
        onChange={(e) => {
          const key = e.target.value as SortKey;
          onChange({ key, direction: key === "spend" || key === "count" ? "desc" : "asc" });
        }}>
        {options.map((o) => <option key={o.key} value={o.key} disabled={o.key === "spend" && !costsEnabled}>{o.label}</option>)}
      </select></label>
      <button aria-label={`Sort ${value.direction === "asc" ? "descending" : "ascending"}`}
        disabled={!costsEnabled && value.key === "spend"}
        onClick={() => onChange({ ...value, direction: value.direction === "asc" ? "desc" : "asc" })}>
        {value.direction === "asc" ? "Ascending" : "Descending"}
      </button>
    </div>
  );
}

export function ExploreToolbar({ filters, facets, match, onMatch, onChange, onReset, count, total }: {
  filters: Filters; facets: Record<FilterFacet, FacetOption[]>; match: TypeMatch; onMatch: (match: TypeMatch) => void;
  onChange: (filters: Filters) => void; onReset: () => void; count: number; total: number;
}) {
  const active = !!(filters.search || filters.subscriptions.length || filters.resourceGroups.length || filters.types.length);
  return (
    <section className="explore-toolbar" aria-label="Resource filters">
      <div className="filter-row">
        <input className="resource-search" type="search" aria-label="Search resources" placeholder="Search name or type..."
          value={filters.search} onChange={(e) => onChange({ ...filters, search: e.target.value })} />
        <FacetSelect title="Subscription" options={facets.subscriptions} selected={filters.subscriptions}
          onChange={(subscriptions) => onChange({
            ...filters, subscriptions,
            resourceGroups: subscriptions.length
              ? filters.resourceGroups.filter((rg) => subscriptions.some((sub) => rg.startsWith(`${sub.toLowerCase()}/`)))
              : filters.resourceGroups,
          })} />
        <FacetSelect title="Resource group" options={facets.resourceGroups} selected={filters.resourceGroups}
          onChange={(resourceGroups) => onChange({ ...filters, resourceGroups })} />
        <FacetSelect title="Resource type" options={facets.types} selected={filters.types}
          onChange={(types) => onChange({ ...filters, types })} />
        <label className="type-match">Types match <select aria-label="Type matching" value={match} onChange={(e) => onMatch(e.target.value as TypeMatch)}>
          <option value="any">Any (OR)</option><option value="all">All (AND)</option>
        </select></label>
        <span className="filter-count" aria-live="polite">{count} / {total} resources in scope</span>
        {active && <button onClick={onReset}>Reset filters</button>}
      </div>
      {active && <div className="filter-chips" aria-label="Selected filters">
        {(["subscriptions", "resourceGroups", "types"] as const).flatMap((facet) => filters[facet].map((value) => {
          const option = facets[facet].find((o) => o.value === value);
          const label = option?.label ?? value;
          return <button key={`${facet}:${value}`} title={value} className={option?.count === 0 ? "unavailable" : ""}
            aria-label={`Remove ${label}`} onClick={() => onChange({ ...filters, [facet]: filters[facet].filter((v) => v !== value) })}>
            {label} <span aria-hidden="true">x</span>
          </button>;
        }))}
        {filters.search && <button aria-label="Clear resource search" onClick={() => onChange({ ...filters, search: "" })}>Search: {filters.search} <span aria-hidden="true">x</span></button>}
      </div>}
    </section>
  );
}
