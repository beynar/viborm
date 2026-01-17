/**
 * Memory Cache
 *
 * In-memory cache implementation for development/testing.
 * Suitable for single-instance deployments.
 */

import { CacheDriver, type CacheEntry } from "../driver";

/**
 * In-memory cache implementation
 */
export class MemoryCache extends CacheDriver {
  private readonly store = new Map<string, CacheEntry>();

  constructor() {
    super("memory");
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
    this.store.set(key, entry);
    // Schedule cleanup after storageTtl to prevent unbounded growth
    // Use unref() so the timer doesn't keep the process alive
    const timer = setTimeout(() => this.store.delete(key), storageTtl);
    if (typeof timer.unref === "function") timer.unref();
  }

  protected async delete(keys: string[]): Promise<void> {
    for (const key of keys) {
      this.store.delete(key);
    }
  }

  protected async clear(prefix: string): Promise<void> {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
      }
    }
  }
}
