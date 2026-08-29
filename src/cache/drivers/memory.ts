/**
 * Memory Cache
 *
 * In-memory cache implementation for development/testing.
 * Suitable for single-instance deployments.
 *
 * @example
 * ```ts
 * // Direct import for optimal tree-shaking
 * import { cache } from "viborm/cache";
 * import { MemoryCache } from "viborm/cache/memory";
 *
 * const client = createClient({ schema, driver }).$extends(
 *   cache({ driver: new MemoryCache() })
 * );
 * ```
 */

import type { ClockTimer } from "../../clock";
import { CacheConfigurationError } from "../../errors";
import { CacheDriver, type CacheEntry } from "../driver";

/**
 * In-memory cache implementation
 */
export class MemoryCache extends CacheDriver {
  private readonly store = new Map<string, CacheEntry>();
  private readonly timers = new Map<string, ClockTimer>();

  constructor(...extra: never[]) {
    super("memory");
    if (extra.length !== 0) {
      throw new CacheConfigurationError(
        "MemoryCache does not accept construction options."
      );
    }
  }

  protected async get<T>(key: string): Promise<CacheEntry<T> | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    return entry as CacheEntry<T>;
  }

  protected async set<T>(
    key: string,
    storageTtl: number,
    entry: CacheEntry<T>
  ): Promise<void> {
    // Clear existing timer if re-setting key
    this.clearTimer(key);
    this.store.set(key, entry);
    // Schedule cleanup after storageTtl to prevent unbounded growth
    const timer = this.clock.setTimeout(() => {
      this.store.delete(key);
      this.timers.delete(key);
    }, storageTtl);
    timer.unref?.();
    this.timers.set(key, timer);
  }

  protected async delete(keys: string[]): Promise<void> {
    for (const key of keys) {
      this.clearTimer(key);
      this.store.delete(key);
    }
  }

  protected async clear(prefix: string): Promise<void> {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.clearTimer(key);
        this.store.delete(key);
      }
    }
  }

  private clearTimer(key: string): void {
    const timer = this.timers.get(key);
    if (timer) {
      timer.cancel();
      this.timers.delete(key);
    }
  }
}
