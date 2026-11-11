import { config } from "../config";
import type { KeyValueStore } from "./types";

let store: KeyValueStore | undefined;

/** Backends are loaded lazily so e.g. SQLite is never opened when running on Table Storage. */
export async function getStore(): Promise<KeyValueStore> {
  store ??= config.store === "table" ? (await import("./table")).tableStore : (await import("./sqlite")).sqliteStore;
  return store;
}
