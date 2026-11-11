// Resolve an icon for an ARM resource type.
// Drop official Azure Architecture Icons (SVG) into ./azure/ — files are matched by keyword in the
// filename (e.g. "10021-icon-service-Virtual-Machine.svg" matches "virtual-machine").
// Types without a matching file fall back to a coloured badge.

const files = import.meta.glob("./azure/*.svg", { eager: true, query: "?url", import: "default" }) as Record<string, string>;
const fileList = Object.entries(files).map(([path, url]) => ({ name: path.toLowerCase(), url }));

interface Meta { keywords: string[]; label: string; color: string }
const compute = "#0078d4", net = "#5c2d91", data = "#107c10", sec = "#c239b3", app = "#00a4ef";

export const iconMeta: Record<string, Meta> = {
  "microsoft.compute/virtualmachines": { keywords: ["virtual-machine"], label: "VM", color: compute },
  "microsoft.compute/disks": { keywords: ["disks"], label: "DSK", color: compute },
  "microsoft.network/virtualnetworks": { keywords: ["virtual-networks"], label: "VNET", color: net },
  "microsoft.network/networkinterfaces": { keywords: ["network-interface"], label: "NIC", color: net },
  "microsoft.network/networksecuritygroups": { keywords: ["network-security-groups"], label: "NSG", color: net },
  "microsoft.network/publicipaddresses": { keywords: ["public-ip-addresses"], label: "PIP", color: net },
  "microsoft.network/privateendpoints": { keywords: ["private-endpoint"], label: "PE", color: net },
  "microsoft.web/sites": { keywords: ["app-services"], label: "APP", color: app },
  "microsoft.web/serverfarms": { keywords: ["app-service-plans"], label: "ASP", color: app },
  "microsoft.sql/servers": { keywords: ["sql-server"], label: "SQL", color: data },
  "microsoft.storage/storageaccounts": { keywords: ["storage-accounts"], label: "STG", color: data },
  "microsoft.cache/redis": { keywords: ["cache-redis"], label: "RDS", color: data },
  "microsoft.keyvault/vaults": { keywords: ["key-vaults"], label: "KV", color: sec },
};

export function shortType(type: string) {
  return type.split("/").slice(1).join("/") || type;
}

const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, "");
// Official files look like "10021-icon-service-Virtual-Machine.svg"; compare on the part after "icon-service-".
const fileKeys = fileList.map((f) => ({ url: f.url, key: norm(f.name.replace(/^.*\/\d+-icon-service-/, "").replace(/\.svg$/, "")) }));

/** Best guess for types without an explicit entry: ARM type segment (e.g. "virtualmachines") vs filename. */
function guessIcon(type: string): string | undefined {
  const seg = norm(type.split("/").pop() ?? "");
  const stem = seg.replace(/ies$/, "y").replace(/s$/, "");
  if (stem.length < 4) return undefined;
  return fileKeys.filter((f) => f.key.includes(stem)).sort((a, b) => a.key.length - b.key.length)[0]?.url;
}

export function resolveIcon(type: string): { url?: string; label: string; color: string } {
  const m = iconMeta[type];
  const explicit = m && fileList.find((f) => m.keywords.some((k) => f.name.includes(k)))?.url;
  const url = explicit ?? guessIcon(type);
  if (m) return { url, label: m.label, color: m.color };
  return { url, label: shortType(type).slice(0, 3).toUpperCase(), color: "#6b6b6b" };
}
