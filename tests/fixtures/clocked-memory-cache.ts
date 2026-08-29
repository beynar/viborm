import { CacheDriver, type CacheEntry } from "@cache/driver";
import type { Clock, ClockTimer } from "@src/clock";

/** Test-only in-memory backend whose clock can advance without sleeping. */
export class ClockedMemoryCache extends CacheDriver {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly timers = new Map<string, ClockTimer>();

  constructor(clock: Clock) {
    super("clocked-memory", clock);
  }

  protected async get<T>(key: string): Promise<CacheEntry<T> | null> {
    const entry = this.entries.get(key);
    return entry ? (entry as CacheEntry<T>) : null;
  }

  protected async set<T>(
    key: string,
    storageTtl: number,
    entry: CacheEntry<T>
  ): Promise<void> {
    this.cancel(key);
    this.entries.set(key, entry);
    const timer = this.clock.setTimeout(() => {
      this.entries.delete(key);
      this.timers.delete(key);
    }, storageTtl);
    this.timers.set(key, timer);
  }

  protected async delete(keys: string[]): Promise<void> {
    for (const key of keys) {
      this.cancel(key);
      this.entries.delete(key);
    }
  }

  protected async clear(prefix: string): Promise<void> {
    for (const key of this.entries.keys()) {
      if (!key.startsWith(prefix)) continue;
      this.cancel(key);
      this.entries.delete(key);
    }
  }

  private cancel(key: string): void {
    this.timers.get(key)?.cancel();
    this.timers.delete(key);
  }
}
