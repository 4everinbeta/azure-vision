import { Handle, Position, type NodeProps } from "@xyflow/react";
import { roleOf, type Resource, type Role } from "@azure-vision/shared";
import { resolveIcon, shortType } from "../icons";
import { addressSpaceOf, subnetsOf } from "../networkLayout";

export const roleColors: Record<Role, string> = {
  edge: "#e8590c", network: "#7048e8", compute: "#1c7ed6", data: "#2f9e44", security: "#d6336c", ops: "#868e96", other: "#adb5bd",
};

export function ResourceIcon({ type, size = 36 }: { type: string; size?: number }) {
  const icon = resolveIcon(type);
  if (icon.url) return <img src={icon.url} width={size} height={size} alt="" draggable={false} />;
  return (
    <div className="badge" style={{ background: roleColors[roleOf(type)], width: size, height: size, fontSize: size / 3.4 }}>
      {icon.label}
    </div>
  );
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
const childSummary = (children: Resource[]) => {
  const counts = new Map<string, number>();
  for (const c of children) counts.set(shortType(c.type), (counts.get(shortType(c.type)) ?? 0) + 1);
  return [...counts].map(([t, n]) => (n > 1 ? `${n}× ${t}` : t));
};

export function CardNode({ data, selected }: NodeProps) {
  const d = data as { resource: Resource; children: Resource[]; costLabel?: string; heatColor?: string; dim?: boolean };
  const r = d.resource;
  return (
    <div
      className={`card-node${selected ? " selected" : ""}${d.dim ? " dim" : ""}${d.heatColor ? " heated" : ""}`}
      style={{ borderLeftColor: roleColors[roleOf(r.type)], background: d.heatColor }}
      title={`${r.name}\n${r.type}${d.children.length ? `\n+ ${childSummary(d.children).join(", ")}` : ""}${d.costLabel ? `\n${d.costLabel}` : ""}`}
    >
      <Handle type="target" position={Position.Left} />
      <ResourceIcon type={r.type} />
      <div className="card-text">
        <div className="card-name">{r.name}</div>
        <div className="card-type">{shortType(r.type)}</div>
        <div className="card-meta">
          {d.children.length > 0 && <span className="chip" title={childSummary(d.children).join(", ")}>+{plural(d.children.length, "item")}</span>}
          {d.costLabel && <span className="chip cost">{d.costLabel}</span>}
        </div>
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const centre = { top: "50%", left: "50%" };

export function VNetNode({ data, selected }: NodeProps) {
  const { resource: r, color, costLabel, heatColor } = data as {
    resource: Resource; color: string; costLabel?: string; heatColor?: string;
  };
  const icon = resolveIcon(r.type);
  const subnets = subnetsOf(r);
  return (
    <div className={`vnet-node${selected ? " selected" : ""}`} style={{ borderColor: color, background: heatColor }}>
      <Handle type="target" position={Position.Top} style={centre} />
      <Handle type="source" position={Position.Top} style={centre} />
      <div className="vnet-head" style={{ background: color }}>
        {icon.url ? <img src={icon.url} width={20} height={20} alt="" draggable={false} /> : null}
        <strong>{r.name}</strong>
        {costLabel && <span className="vnet-cost">{costLabel}</span>}
      </div>
      <div className="vnet-sub">{r.subscriptionName ?? r.subscriptionId} · {r.resourceGroup}</div>
      <div className="vnet-addr">{addressSpaceOf(r).join(", ")}</div>
      {subnets.slice(0, 6).map((s) => (
        <div key={s.name} className="vnet-subnet">{s.name} <em>{s.prefix}</em></div>
      ))}
      {subnets.length > 6 && <div className="vnet-subnet">+{subnets.length - 6} more</div>}
    </div>
  );
}
