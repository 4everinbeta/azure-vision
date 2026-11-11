import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { TableClient } from "@azure/data-tables";
import { ManagedIdentityCredential } from "@azure/identity";

let stage = "configuration";

async function verify() {
  const endpoint = new URL(process.env.STORAGE_TABLE_ENDPOINT);
  const expected = new Set((process.env.EXPECTED_STORAGE_IPS ?? "").split(",").filter(Boolean));
  const clientId = process.env.MANAGED_IDENTITY_CLIENT_ID;
  assert.equal(endpoint.protocol, "https:");
  assert.ok(expected.size > 0, "Expected private endpoint IPs are required");
  assert.ok(clientId, "A user-assigned managed identity client ID is required");

  stage = "private DNS";
  const addresses = await lookup(endpoint.hostname, { all: true });
  assert.ok(addresses.length > 0);
  assert.ok(addresses.every(({ address }) => expected.has(address)), "DNS did not resolve exclusively to the expected private endpoint");
  console.log(JSON.stringify({ check: stage, ok: true, addresses: addresses.map(({ address }) => address) }));

  const client = new TableClient(
    endpoint.toString(),
    process.env.STORAGE_TABLE_NAME ?? "inventory",
    new ManagedIdentityCredential({ clientId }),
  );
  const ownership = randomUUID();
  const partitionKey = `validation-${ownership}`;
  const rowKey = "private-storage-probe";
  let created = false;
  try {
    stage = "managed-identity table write";
    for (let attempt = 0; ; attempt++) {
      try {
        await client.createEntity({ partitionKey, rowKey, ownership });
        created = true;
        break;
      } catch (error) {
        if (error.statusCode !== 403 || attempt >= 11) throw error;
        console.warn(JSON.stringify({ check: stage, ready: false, status: 403, retry: attempt + 1 }));
        await sleep(10_000);
      }
    }
    stage = "managed-identity table read";
    const stored = await client.getEntity(partitionKey, rowKey);
    assert.equal(stored.ownership, ownership);
  } finally {
    if (created) {
      stage = "validation entity cleanup";
      const stored = await client.getEntity(partitionKey, rowKey);
      assert.equal(stored.ownership, ownership, "Refusing to delete an entity not owned by this probe");
      await client.deleteEntity(partitionKey, rowKey, { etag: stored.etag });
    }
  }
  console.log(JSON.stringify({ check: "private managed-identity table read/write/delete", ok: true }));
}

verify().catch((error) => {
  console.error(JSON.stringify({
    check: stage,
    ok: false,
    error: error.name,
    code: error.code,
    status: error.statusCode,
  }));
  process.exitCode = 1;
});
