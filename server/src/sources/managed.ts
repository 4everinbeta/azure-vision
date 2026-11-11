import { DefaultAzureCredential } from "@azure/identity";
import { config } from "../config";
import { ARM_SCOPE, queryInventory } from "./arg";
import type { ResourceSource } from "./types";

// In Azure this is the container app's managed identity; locally it falls back to `az login` / env credentials.
const credential = new DefaultAzureCredential({ managedIdentityClientId: config.managedIdentityClientId });

export const getManagedToken = async () => (await credential.getToken(ARM_SCOPE)).token;

export const managedSource: ResourceSource = {
  async fetchInventory() {
    return queryInventory(await getManagedToken());
  },
};
