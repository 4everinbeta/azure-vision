import { DefaultAzureCredential } from "@azure/identity";
import { TableClient, type TableTransaction } from "@azure/data-tables";
import { config } from "../config";
import { fromChunks, toChunks } from "./chunks";
import type { KeyValueStore } from "./types";

// Layout: PartitionKey = sanitised cache key (one partition per identity).
//   RowKey "meta"            -> { version, fetchedAt, chunks }
//   RowKey "v<version>-<n>"  -> { data } (one chunk of the compressed snapshot)
// The meta row is written last, so readers never see a half-written snapshot.
const BATCH = 50;
const partitionOf = (key: string) => key.replace(/[\\/#?\u0000-\u001f\u007f-\u009f]/g, "_");
const rowOf = (version: number, n: number) => `v${version}-${String(n).padStart(5, "0")}`;

let client: TableClient | undefined;
async function table() {
  if (!client) {
    client = new TableClient(config.tableEndpoint, config.tableName, new DefaultAzureCredential({
      managedIdentityClientId: config.managedIdentityClientId,
    }));
    await client.createTable().catch(() => undefined); // already exists
  }
  return client;
}

async function submit(t: TableClient, partitionKey: string, actions: Array<["upsert" | "delete", any]>) {
  for (let i = 0; i < actions.length; i += BATCH) {
    await t.submitTransaction(actions.slice(i, i + BATCH).map(([op, e]) =>
      op === "upsert" ? ["upsert", e, "Replace"] : ["delete", e.partitionKey, e.rowKey]) as TableTransaction["actions"]);
  }
}

export const tableStore: KeyValueStore = {
  async get<T>(key: string, ttlMs: number) {
    const t = await table();
    const pk = partitionOf(key);
    const meta = await t.getEntity<{ version: number; fetchedAt: number; chunks: number }>(pk, "meta").catch(() => undefined);
    if (!meta || Date.now() - meta.fetchedAt >= ttlMs) return undefined;
    const rows: { rowKey: string; data: string }[] = [];
    for await (const e of t.listEntities<{ data: string }>({
      queryOptions: { filter: `PartitionKey eq '${pk}' and RowKey ge '${rowOf(meta.version, 0)}' and RowKey le '${rowOf(meta.version, 99999)}'` },
    })) rows.push({ rowKey: e.rowKey!, data: e.data });
    if (rows.length !== meta.chunks) return undefined; // incomplete (e.g. concurrent cleanup): treat as a miss
    return fromChunks<T>(rows.sort((a, b) => a.rowKey.localeCompare(b.rowKey)).map((r) => r.data));
  },

  async put<T>(key: string, value: T) {
    const t = await table();
    const pk = partitionOf(key);
    const version = Date.now();
    const chunks = toChunks(value);
    await submit(t, pk, chunks.map((data, n) => ["upsert", { partitionKey: pk, rowKey: rowOf(version, n), data }]));
    await t.upsertEntity({ partitionKey: pk, rowKey: "meta", version, fetchedAt: version, chunks: chunks.length }, "Replace");

    // Remove chunks from older snapshots.
    const stale: Array<["delete", any]> = [];
    for await (const e of t.listEntities({ queryOptions: { filter: `PartitionKey eq '${pk}' and RowKey ne 'meta'`, select: ["RowKey"] } })) {
      if (!e.rowKey!.startsWith(`v${version}-`)) stale.push(["delete", { partitionKey: pk, rowKey: e.rowKey }]);
    }
    await submit(t, pk, stale);
  },
};
