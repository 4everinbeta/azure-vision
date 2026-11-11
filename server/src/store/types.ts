/** Namespaced JSON cache: callers prefix keys (e.g. "cost:<identity>:<period>") to keep data kinds apart. */
export interface KeyValueStore {
  /** Returns the stored value if it is younger than ttlMs. */
  get<T>(key: string, ttlMs: number): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}
