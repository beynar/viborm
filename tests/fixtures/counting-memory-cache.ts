import type { CacheEntry } from "@cache/driver";
import { MemoryCache } from "@cache/drivers/memory";

/** Test-only memory cache that counts the reads and writes asked of it. */
export class CountingMemoryCache extends MemoryCache {
  reads = 0;
  writes = 0;

  protected override async get<T>(key: string): Promise<CacheEntry<T> | null> {
    this.reads += 1;
    return await super.get<T>(key);
  }

  protected override async set<T>(
    key: string,
    storageTtl: number,
    entry: CacheEntry<T>
  ): Promise<void> {
    this.writes += 1;
    await super.set(key, storageTtl, entry);
  }
}
