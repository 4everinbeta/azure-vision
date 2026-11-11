export type SortKey = "name" | "spend" | "count" | "type" | "location";
export interface SortPrefs { key: SortKey; direction: "asc" | "desc" }
export const defaultSort: SortPrefs = { key: "name", direction: "asc" };

interface Sortable { id: string; name: string; spend?: number; count?: number; type?: string; location?: string }

export function compareExplore(a: Sortable, b: Sortable, prefs: SortPrefs): number {
  const key = prefs.key;
  const av = key === "name" ? a.name : a[key];
  const bv = key === "name" ? b.name : b[key];
  if (av === undefined && bv !== undefined) return 1;
  if (bv === undefined && av !== undefined) return -1;
  const result = typeof av === "number" && typeof bv === "number" ? av - bv
    : typeof av === "string" && typeof bv === "string" ? av.localeCompare(bv, undefined, { numeric: true, sensitivity: "base" }) : 0;
  return (prefs.direction === "asc" ? result : -result) ||
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) || a.id.localeCompare(b.id);
}

export function readSort(params: URLSearchParams, resourceList: boolean): SortPrefs {
  const key = params.get(resourceList ? "resourceSort" : "sort");
  const allowed = resourceList ? ["name", "spend", "type", "location"] : ["name", "spend", "count"];
  const validKey = allowed.includes(key ?? "") ? key as SortKey : "name";
  const direction = params.get(resourceList ? "resourceOrder" : "order");
  return { key: validKey, direction: direction === "desc" || direction === "asc" ? direction : validKey === "spend" || validKey === "count" ? "desc" : "asc" };
}
