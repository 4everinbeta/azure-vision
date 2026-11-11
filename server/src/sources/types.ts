import type { Inventory } from "@azure-vision/shared";

export interface ResourceSource {
  /** userToken is the caller's bearer token (undefined for mock). */
  fetchInventory(userToken?: string): Promise<Inventory>;
}
