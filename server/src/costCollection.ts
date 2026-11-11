import type { KeyValueStore } from "./store/types";
import type { SubscriptionCost } from "./sources/cost";

export type FetchSub = (sub: string) => Promise<SubscriptionCost>;

interface Job { running: boolean; remaining: number; failed: Map<string, { message: string; at: number }> }

export interface Collected {
  /** Cached cost per subscription (possibly stale while a forced refresh is running). */
  have: Map<string, SubscriptionCost>;
  /** Subscriptions still queued or in flight. */
  pending: number;
  /** Subscriptions whose last attempt failed, with the reason. */
  failures: Map<string, string>;
}

interface Options {
  store: KeyValueStore;
  /** How long a subscription's data is served without re-querying (24h by default upstream). */
  ttlMs: number;
  /** Pause between subscriptions: Cost Management throttles aggressively per tenant. */
  spacingMs: number;
  /** A failed subscription is not retried by passive reads until this much time has passed. */
  retryFailedAfterMs: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onDone?: (scope: string, period: string, c: Collected) => void;
  onError?: (sub: string, e: Error) => void;
}

/**
 * Builds a per-subscription cost collection in the background, one subscription at a time, persisting each
 * result as it arrives. Requests return whatever is cached right away, so a throttled tenant fills in over
 * several polls instead of failing outright.
 */
export class CostCollection {
  private jobs = new Map<string, Job>();
  private sleep: (ms: number) => Promise<void>;
  private now: () => number;

  constructor(private o: Options) {
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = o.now ?? Date.now;
  }

  private key = (scope: string, period: string, sub: string) => `costsub:${scope}:${period}:${sub}`;

  private async read(scope: string, period: string, subs: string[]) {
    const have = new Map<string, SubscriptionCost>();
    await Promise.all(subs.map(async (s) => {
      const hit = await this.o.store.get<SubscriptionCost>(this.key(scope, period, s), this.o.ttlMs);
      if (hit) have.set(s, hit);
    }));
    return have;
  }

  /** Returns cached data now and starts a background fetch for anything missing (or everything, when forced). */
  async request(scope: string, period: string, subs: string[], fetchSub: FetchSub, refresh = false): Promise<Collected> {
    const id = `${scope}|${period}`;
    const job = this.jobs.get(id) ?? { running: false, remaining: 0, failed: new Map() };
    this.jobs.set(id, job);
    const have = await this.read(scope, period, subs);
    if (!job.running) {
      const cooling = (s: string) => {
        const f = job.failed.get(s);
        return !!f && this.now() - f.at < this.o.retryFailedAfterMs;
      };
      const todo = refresh ? subs : subs.filter((s) => !have.has(s) && !cooling(s));
      if (todo.length) {
        job.running = true;
        job.remaining = todo.length;
        if (refresh) job.failed.clear();
        void this.run(scope, period, subs, todo, fetchSub, job);
      }
    }
    return this.snapshot(have, job, subs);
  }

  private snapshot(have: Map<string, SubscriptionCost>, job: Job, subs: string[]): Collected {
    const wanted = new Set(subs);
    return {
      have,
      pending: job.running ? job.remaining : 0,
      failures: new Map([...job.failed].filter(([s]) => wanted.has(s) && !have.has(s)).map(([s, f]) => [s, f.message])),
    };
  }

  private async run(scope: string, period: string, subs: string[], todo: string[], fetchSub: FetchSub, job: Job) {
    try {
      for (let i = 0; i < todo.length; i++) {
        if (i > 0) await this.sleep(this.o.spacingMs);
        const sub = todo[i];
        try {
          await this.o.store.put(this.key(scope, period, sub), await fetchSub(sub));
          job.failed.delete(sub);
        } catch (e) {
          job.failed.set(sub, { message: (e as Error).message, at: this.now() });
          this.o.onError?.(sub, e as Error);
        }
        job.remaining--;
      }
    } finally {
      job.running = false;
      job.remaining = 0;
      this.o.onDone?.(scope, period, this.snapshot(await this.read(scope, period, subs), job, subs));
    }
  }
}
