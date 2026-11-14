/** In-memory LRU cache with a bounded entry count and one expiry sweep. */
import { CacheConfigurationError } from "../../errors";
import { CacheDriver, type CacheEntry, type CacheTimer } from "../driver";

export interface MemoryCacheOptions {
  readonly maxEntries: number;
}

export class MemoryCache<
  const Options extends MemoryCacheOptions = MemoryCacheOptions,
> extends CacheDriver {
  readonly #store = new Map<string, { entry: CacheEntry; expiresAt: number }>();
  readonly #maxEntries: number;
  #timer?: CacheTimer;

  constructor(
    options?: Options &
      Record<Exclude<keyof Options, keyof MemoryCacheOptions>, never>
  ) {
    super("memory");
    let maxEntries = 1024;
    if (options !== undefined) {
      const descriptors = Object.getOwnPropertyDescriptors(options);
      const limit = descriptors.maxEntries;
      const supplied: unknown =
        limit && "value" in limit ? limit.value : undefined;
      if (
        Reflect.ownKeys(descriptors).length !== 1 ||
        !limit ||
        !("value" in limit) ||
        typeof supplied !== "number" ||
        !Number.isSafeInteger(supplied) ||
        supplied < 1
      )
        throw new CacheConfigurationError(
          "MemoryCache options must contain a positive safe-integer maxEntries only."
        );
      maxEntries = supplied;
    }
    this.#maxEntries = maxEntries;
  }

  protected async get<T>(key: string): Promise<CacheEntry<T> | null> {
    const stored = this.#store.get(key);
    if (!stored) return null;
    this.#store.delete(key);
    if (this.clock.now() >= stored.expiresAt) {
      this.#idle();
      return null;
    }
    this.#store.set(key, stored);
    return stored.entry as CacheEntry<T>;
  }

  protected async set<T>(
    key: string,
    storageTtl: number,
    entry: CacheEntry<T>
  ): Promise<void> {
    this.#store.delete(key);
    this.#store.set(key, { entry, expiresAt: this.clock.now() + storageTtl });
    // Past the bound the store holds an entry: the oldest is the first key.
    while (this.#store.size > this.#maxEntries)
      this.#store.delete(this.#store.keys().next().value!);
    this.#schedule(storageTtl);
  }

  protected async delete(keys: string[]): Promise<void> {
    for (const key of keys) this.#store.delete(key);
    this.#idle();
  }

  protected async clear(prefix: string): Promise<void> {
    for (const key of this.#store.keys())
      if (key.startsWith(prefix)) this.#store.delete(key);
    this.#idle();
  }

  #idle(): void {
    if (this.#store.size) return;
    this.#timer?.cancel();
    this.#timer = undefined;
  }

  #schedule(delay = 60_000): void {
    if (this.#timer || !this.#store.size) return;
    this.#timer = this.clock.setTimeout(
      () => {
        this.#timer = undefined;
        const now = this.clock.now();
        for (const [key, stored] of this.#store)
          if (now >= stored.expiresAt) this.#store.delete(key);
        this.#schedule();
      },
      Math.min(delay, 60_000)
    );
    this.#timer.unref?.();
  }

  override async disconnect(): Promise<void> {
    this.#store.clear();
    this.#idle();
  }
}
