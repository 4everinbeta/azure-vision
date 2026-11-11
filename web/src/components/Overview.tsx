import { useMemo } from "react";
import { formatCost, rgKey, roleLabels, roleOf, roleOrder, type CostRollup, type Inventory, type Role } from "@azure-vision/shared";
import { roleColors } from "./nodes";
import { compareExplore, type SortPrefs } from "../exploreSort";

export interface Nav { sub?: string; rg?: string }

interface CardData { key: string; title: string; subtitle: string; count: number; roles: Map<Role, number>; cost?: number }

function RoleBar({ roles, total }: { roles: Map<Role, number>; total: number }) {
  return (
    <>
      <div className="rolebar">
        {roleOrder.filter((r) => roles.has(r)).map((r) => (
          <i key={r} style={{ background: roleColors[r], flex: roles.get(r)! / total }} title={`${roleLabels[r]}: ${roles.get(r)}`} />
        ))}
      </div>
      <div className="rolelegend">
        {roleOrder.filter((r) => roles.has(r)).map((r) => <span key={r}><i style={{ background: roleColors[r] }} />{roleLabels[r]} {roles.get(r)}</span>)}
      </div>
    </>
  );
}

/** Subscription cards (tenant level) or resource-group cards (subscription level). */
export function Overview({ inv, nav, rollup, currency, sort, onOpen }: {
  inv: Inventory; nav: Nav; rollup?: CostRollup; currency?: string; sort: SortPrefs; onOpen: (n: Nav) => void;
}) {
  const cards = useMemo(() => {
    const m = new Map<string, CardData & { rgs: Set<string> }>();
    for (const r of inv.resources) {
      if (nav.sub && r.subscriptionId !== nav.sub) continue;
      const key = nav.sub ? rgKey(r) : r.subscriptionId;
      const c = m.get(key) ?? {
        key, title: nav.sub ? r.resourceGroup : r.subscriptionName ?? r.subscriptionId, subtitle: r.location,
        count: 0, roles: new Map(), rgs: new Set<string>(),
      };
      c.count++;
      c.rgs.add(rgKey(r));
      const role = roleOf(r.type);
      c.roles.set(role, (c.roles.get(role) ?? 0) + 1);
      m.set(key, c);
    }
    return [...m.values()].map((c) => ({
      ...c,
      subtitle: nav.sub ? c.subtitle : `${c.rgs.size} resource group${c.rgs.size === 1 ? "" : "s"}`,
      cost: nav.sub ? rollup?.resourceGroup.get(c.key) : rollup?.subscription.get(c.key),
    })).sort((a, b) => compareExplore(
      { id: a.key, name: a.title, spend: a.cost, count: a.count },
      { id: b.key, name: b.title, spend: b.cost, count: b.count }, sort,
    ));
  }, [inv, nav.sub, rollup, sort]);

  const unalloc = nav.sub ? rollup?.unallocated.get(nav.sub) : undefined;
  return (
    <div className="overview">
      <div className="cards">
        {cards.map((c) => (
          <button key={c.key} className="ov-card" onClick={() => onOpen(nav.sub ? { sub: nav.sub, rg: c.key } : { sub: c.key })}>
            <div className="ov-head">
              <strong>{c.title}</strong>
              {currency && <span className="chip cost">{c.cost === undefined ? "Spend unavailable" : formatCost(c.cost, currency)}</span>}
            </div>
            <div className="ov-sub">{c.subtitle} · {c.count} resource{c.count === 1 ? "" : "s"}</div>
            <RoleBar roles={c.roles} total={c.count} />
          </button>
        ))}
      </div>
      {unalloc && currency ? <p className="note">{formatCost(unalloc, currency)} of this subscription's cost is not attributable to a resource in the inventory (deleted resources, tax, purchases).</p> : null}
      {!cards.length && <p className="note">Nothing matches the current filters.</p>}
    </div>
  );
}
