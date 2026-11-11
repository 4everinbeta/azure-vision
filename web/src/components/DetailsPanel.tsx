import { useEffect, useState } from "react";
import { formatCost, type CostBreakdown, type CostPeriod, type Resource } from "@azure-vision/shared";
import { authHeaders } from "../auth";

export interface ResourceCost {
  period: CostPeriod;
  periodLabel: string;
  currency: string;
  value?: number;
  rgTotal?: number;
  subTotal?: number;
}

const pct = (part: number, whole: number) => `${Math.round((part / whole) * 100)}%`;

function Breakdown({ resourceId, period, currency }: { resourceId: string; period: CostPeriod; currency: string }) {
  const [data, setData] = useState<CostBreakdown>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    setData(undefined);
    setError(undefined);
    (async () => {
      const res = await fetch(`/api/costs/breakdown?period=${period}&resourceId=${encodeURIComponent(resourceId)}`, {
        headers: await authHeaders(),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      const body: CostBreakdown = await res.json();
      if (live) setData(body);
    })().catch((e) => live && setError((e as Error).message));
    return () => { live = false; };
  }, [resourceId, period]);

  if (error) return <div className="error">Breakdown failed: {error}</div>;
  if (!data) return <div>Loading breakdown…</div>;
  if (!data.items.length) return <div>No cost lines for this period.</div>;
  return (
    <table className="cost-table">
      <tbody>
        {data.items.map((i, n) => (
          <tr key={n}>
            <td>{i.meter || "(no meter)"}<br /><em>{i.serviceName}</em></td>
            <td>{formatCost(i.cost, currency)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function DetailsPanel({ resource, children = [], cost, onClose }: { resource: Resource; children?: Resource[]; cost?: ResourceCost; onClose: () => void }) {
  const { properties, ...summary } = resource;
  const fmt = (v: number) => formatCost(v, cost!.currency);
  return (
    <aside className="details">
      <button className="link" onClick={onClose}>close ✕</button>
      <h3>{resource.name}</h3>
      {children.length > 0 && (
        <section>
          <h4>Attached resources ({children.length})</h4>
          {children.map((c) => <div key={c.id}>{c.name} <small>{c.type}</small></div>)}
        </section>
      )}
      {cost && (
        <section>
          <h4>Cost: {cost.periodLabel}</h4>
          {cost.value === undefined ? (
            <div>Cost data unavailable for this resource.</div>
          ) : (
            <>
              <strong>{fmt(cost.value)}</strong>
              {cost.rgTotal ? <div>{pct(cost.value, cost.rgTotal)} of full resource group ({fmt(cost.rgTotal)})</div> : null}
              {cost.subTotal ? <div>{pct(cost.value, cost.subTotal)} of full subscription ({fmt(cost.subTotal)})</div> : null}
              <h4>By service and meter</h4>
              <Breakdown resourceId={resource.id} period={cost.period} currency={cost.currency} />
            </>
          )}
        </section>
      )}
      <dl>
        {Object.entries(summary).filter(([k]) => k !== "tags").map(([k, v]) => (
          <div key={k}><dt>{k}</dt><dd>{String(v)}</dd></div>
        ))}
        {Object.entries(resource.tags).map(([k, v]) => (
          <div key={k}><dt>tag: {k}</dt><dd>{v}</dd></div>
        ))}
      </dl>
      <details>
        <summary>Properties (JSON)</summary>
        <pre>{JSON.stringify(properties, null, 2)}</pre>
      </details>
    </aside>
  );
}
