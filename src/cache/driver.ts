/**
 * Cache Driver
 *
 * Abstract base class for cache implementations.
 * Follows the same pattern as the database Driver class.
 * Handles both storage operations and cache orchestration (hit/miss/stale/SWR).
 */

import { CacheInvalidKeyError } from "@errors";
import type { Database } from "@extensions/database";
import { note } from "@extensions/unit-words";
import { ATTR_CACHE_RESULT } from "../instrumentation/spans";
import {
  REVALIDATING_SUFFIX,
  REVALIDATING_TTL_MS,
  scheduleBackground,
} from "./cache-background";
import { CACHE_PREFIX, fastHash, OFFICIAL_CACHE_NAMESPACE_ROOT } from "./key";
import {
  type CacheInvalidationOptions,
  type CacheReadOptions,
  hasCacheInvalidationWork,
} from "./schema";
import {
  cacheOutcome,
  cacheStep,
  placeSetFailure,
  revalidation,
} from "./units";

/** A timer a `CacheClock` armed, cancelled through its handle. */
export interface CacheTimer {
  cancel(): void;
  /** Release the host's hold on the event loop, where it has one. */
  unref?(): void;
}

/**
 * Where a cache reads time and arms its timers: the host's own, unless a
 * test hands a clock it advances instead of sleeping through a TTL.
 */
export interface CacheClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): CacheTimer;
}

const hostClock: CacheClock = {
  // Read when called: a test's fake timers replace `Date.now`.
  now: () => Date.now(),
  setTimeout: (callback, ms) => {
    const timer = setTimeout(callback, ms);
    // A host that is not Node hands back a number, with no `unref`.
    return { cancel: () => clearTimeout(timer), unref: () => timer.unref?.() };
  },
};

/** Extend a request lifetime until background cache work settles. */
export type WaitUntilFn = (promise: Promise<unknown>) => void;

/** Cache entry with freshness metadata for stale-while-revalidate. */
export interface CacheEntry<T = unknown> {
  value: T;
  createdAt: number;
  ttl: number;
  /** Exact operation identity on official detached entries. */
  identity?: string;
  /** Logical expiry, independent of a backend minimum physical TTL. */
  expiresAt?: number;
}

/** Storage options for a cache write. */
export interface CacheSetOptions {
  /** Time to live in milliseconds. */
  ttl: number;
  /** Storage TTL including the stale window, when SWR is enabled. */
  swrTtl?: number;
}

/**
 * One read's codec: `run` runs the prepared read (during the serve, or once
 * after it as a refresh), `snapshot` stores what that run returned.
 */
export interface DetachedCacheResultCodec<T> {
  run(): Promise<T>;
  snapshot(): unknown;
  materialize(snapshot: unknown): T;
}

/** One read the official cache serves, as its extension hands it over. */
export interface CacheServe<T> {
  /** The prepared call's key: equal for two reads that send one statement. */
  readonly id: string;
  readonly codec: DetachedCacheResultCodec<T>;
  readonly read: CacheReadOptions;
  readonly namespace: string;
  readonly waitUntil: WaitUntilFn | undefined;
  readonly model: string;
  readonly operation: string;
  /** The call's `run`: what the read's units and outcomes belong to. */
  readonly origin: object;
  /** The database the read works against, which a revalidation presents. */
  readonly database: Database;
}

type Serve = <T>(cache: CacheDriver, request: CacheServe<T>) => Promise<T>;
let serveFriend: Serve;

type Invalidate = (
  cache: CacheDriver,
  options: CacheInvalidationOptions | undefined,
  origin: object | undefined,
  namespace: string
) => Promise<void>;
let invalidateFriend: Invalidate;

interface PreparedInvalidationTarget {
  readonly kind: "clear" | "delete";
  readonly prefixedKey: string;
}

/**
 * Abstract base class for cache drivers.
 *
 * Follows the same pattern as the database Driver class:
 * - Protected abstract methods for concrete implementations (non-underscored)
 * - Public underscored methods handle key prefixing, instrumentation, and delegation
 * - Instrumentation support
 * - Cache orchestration (hit/miss/stale/SWR logic)
 */
export abstract class CacheDriver {
  #fillRevision = 0;
  readonly driverName: string;
  /**
   * Every freshness decision this class makes reads from here. Internal seam,
   * not public API: it exists so tests can advance time rather than sleep
   * through a TTL. Defaults to the host clock.
   */
  protected readonly clock: CacheClock;

  static {
    serveFriend = (cache, request) => cache.#serve(request);
    invalidateFriend = (cache, options, origin, namespace) =>
      cache.#invalidateScoped("", options, origin, namespace);
  }

  constructor(driverName: string, clock: CacheClock = hostClock) {
    this.driverName = driverName;
    this.clock = clock;
  }

  // ============================================================
  // ABSTRACT METHODS - Concrete drivers implement these
  // ============================================================

  /**
   * Get a value from cache
   */
  protected abstract get<T>(key: string): Promise<CacheEntry<T> | null>;

  /**
   * Set a value in cache
   * @param key - The cache key
   * @param storageTtl - TTL for the backing store (already SWR-compliant)
   * @param entry - Cache entry with user's original TTL for staleness checks
   */
  protected abstract set<T>(
    key: string,
    storageTtl: number,
    entry: CacheEntry<T>
  ): Promise<void>;

  /**
   * Delete keys from cache
   * @param keys - Array of keys to delete
   */
  protected abstract delete(keys: string[]): Promise<void>;

  /**
   * Clear cache by prefix
   * @param prefix - Always provided (at minimum CACHE_PREFIX to avoid clearing unrelated data)
   */
  protected abstract clear(prefix: string): Promise<void>;

  // ============================================================
  // CACHE ORCHESTRATION - Hit/Miss/Stale/SWR logic
  // ============================================================

  async #serve<T>(request: CacheServe<T>): Promise<T> {
    const { id, read, namespace, codec, model, operation, origin } = request;
    const cacheKey = `${model}:${operation}:${fastHash(id)}${read.key === undefined ? "" : `:${read.key}`}`;
    const identity = JSON.stringify([id, read.key]);
    const revision = this.#fillRevision;

    // Bypass cache read if requested
    if (read.bypass) {
      const result = await codec.run();
      this.#setResultInBackground(cacheKey, request, identity, revision);
      note(origin, cacheOutcome("bypass"));
      return result;
    }

    // Try to get from cache
    const cached = await this.#getCachedResult<T>(
      cacheKey,
      origin,
      namespace,
      codec,
      identity
    );

    if (cached) {
      const age = this.clock.now() - cached.createdAt;
      if (age < cached.ttl) {
        // Fresh cache hit
        note(origin, cacheOutcome("hit"));
        return cached.value;
      }

      const swrTtl = read.swr;
      if (
        swrTtl !== false &&
        age < swrTtl &&
        (cached.expiresAt === undefined || this.clock.now() < cached.expiresAt)
      ) {
        // Stale but SWR enabled - return stale and revalidate in background.
        // The refresh runs the read once more after this serve returned: the
        // core alone.
        scheduleBackground(
          this.#revalidateInBackground(
            cacheKey,
            request,
            swrTtl,
            identity,
            revision
          ),
          request.waitUntil
        );
        note(origin, cacheOutcome("hit", "stale"));
        return cached.value;
      }

      // Stale and no SWR - fall through to fetch fresh
    }

    // Cache miss or stale without SWR - execute query
    const result = await codec.run();
    this.#setResultInBackground(cacheKey, request, identity, revision);
    note(origin, cacheOutcome("miss"));
    return result;
  }

  async #getCachedResult<T>(
    key: string,
    origin: object,
    namespace: string,
    codec: DetachedCacheResultCodec<T>,
    identity: string
  ): Promise<CacheEntry<T> | null> {
    const cached = await this.#getScoped<unknown>(key, origin, namespace);
    return cached === null ||
      cached.identity !== identity ||
      !Number.isFinite(cached.createdAt) ||
      !Number.isFinite(cached.ttl) ||
      cached.ttl <= 0 ||
      cached.expiresAt === undefined ||
      !Number.isFinite(cached.expiresAt) ||
      cached.expiresAt < cached.createdAt
      ? null
      : {
          createdAt: cached.createdAt,
          ttl: cached.ttl,
          expiresAt: cached.expiresAt,
          value: codec.materialize(cached.value),
        };
  }

  #setResultInBackground<T>(
    key: string,
    request: CacheServe<T>,
    identity: string,
    revision: number
  ): void {
    if (revision !== this.#fillRevision) return;
    const { read, origin } = request;
    let stored: unknown;
    try {
      stored = request.codec.snapshot();
    } catch (error) {
      note(origin, cacheOutcome("miss", "cache-set-failed", error));
      return;
    }
    // The observed set unit presents a failure; without the catch it would
    // become an unhandled rejection.
    const cachePromise = this.#setScoped(
      key,
      stored,
      {
        ttl: read.ttlMs,
        swrTtl: read.swr !== false ? read.swr : undefined,
      },
      origin,
      request.namespace,
      request,
      identity,
      revision
    ).catch(() => undefined);
    scheduleBackground(cachePromise, request.waitUntil);
  }

  /**
   * Revalidate cache entry in background (for SWR)
   * Uses the backing cache marker for best-effort duplicate suppression.
   */
  async #revalidateInBackground<T>(
    cacheKey: string,
    request: CacheServe<T>,
    swrTtl: number,
    identity: string,
    revision: number
  ): Promise<void> {
    const { namespace, codec, read, origin } = request;
    // Check whether another request has already published this marker.
    let shouldRevalidate: boolean;
    try {
      shouldRevalidate = await this.#markRevalidatingScoped(
        cacheKey,
        namespace
      );
    } catch {
      // If marking fails, skip revalidation to avoid request failure
      return;
    }
    // Another request is handling revalidation, skip
    if (!shouldRevalidate) return;

    await revalidation(origin, request, request.database, async (failure) => {
      let terminal: ReturnType<typeof cacheOutcome>;
      try {
        await codec.run();
        const stored = codec.snapshot();
        await this.#setScoped(
          cacheKey,
          stored,
          { ttl: read.ttlMs, swrTtl },
          origin,
          namespace,
          undefined,
          identity,
          revision
        );
        terminal = cacheOutcome("revalidate", "success", undefined, request);
      } catch (error) {
        // Background work never rejects; its unit presents the failure.
        failure.failed = true;
        failure.error = error;
        terminal = cacheOutcome("revalidate", "error", error, request);
      } finally {
        try {
          await this.#clearRevalidatingScoped(cacheKey, namespace);
        } catch (cleanupFailure) {
          if (failure.failed) {
            const workerFailure = failure.error;
            failure.error = new AggregateError(
              [workerFailure, cleanupFailure],
              "Cache revalidation work and cleanup both failed.",
              { cause: workerFailure }
            );
          } else {
            failure.failed = true;
            failure.error = cleanupFailure;
          }
        }
      }
      return terminal;
    });
  }

  // ============================================================
  // PUBLIC API - Storage operations
  // ============================================================

  /**
   * Get a value from cache
   * @param key - Cache key (will be prefixed automatically)
   */
  async _get<T>(key: string, origin?: object): Promise<CacheEntry<T> | null> {
    return this.#getScoped<T>(key, origin);
  }

  async #getScoped<T>(
    key: string,
    origin?: object,
    namespace?: string
  ): Promise<CacheEntry<T> | null> {
    const prefixedKey = this.#prefixKey(key, namespace);
    return cacheStep("get", origin, this.driverName, async (unit) => {
      const entry = await this.get<T>(prefixedKey);
      if (unit !== undefined)
        note(unit, {
          attributes: {
            [ATTR_CACHE_RESULT]: entry
              ? this.clock.now() - entry.createdAt > entry.ttl
                ? "stale"
                : "hit"
              : "miss",
          },
        });
      return entry;
    });
  }

  /**
   * Set a value in cache
   * @param key - Cache key (will be prefixed automatically)
   * @param value - Value to cache
   * @param options - Cache options including TTL
   */
  async _set<T>(
    key: string,
    value: T,
    options: CacheSetOptions,
    origin?: object
  ): Promise<void> {
    return this.#setScoped(key, value, options, origin);
  }

  async #setScoped<T>(
    key: string,
    value: T,
    options: CacheSetOptions,
    origin?: object,
    namespace?: string,
    /** The read a background set belongs to, whose outcomes a failure joins. */
    background?: CacheServe<unknown>,
    identity?: string,
    revision?: number
  ): Promise<void> {
    if (revision !== undefined && revision !== this.#fillRevision) return;
    const prefixedKey = this.#prefixKey(key, namespace);
    const entry: CacheEntry<T> = {
      value,
      createdAt: this.clock.now(),
      ttl: options.ttl,
      ...(identity === undefined
        ? {}
        : {
            identity,
            expiresAt: this.clock.now() + (options.swrTtl ?? options.ttl),
          }),
    };

    // Use SWR TTL if provided, otherwise just use regular TTL
    const storageTtl = options.swrTtl ?? options.ttl;

    return cacheStep(
      "set",
      origin,
      this.driverName,
      async (unit) => {
        try {
          await this.set(prefixedKey, storageTtl, entry);
          // A durable invalidation may finish while a backend set is pending.
          // Suppress this obsolete fill locally; generic KV remains eventual.
          if (revision !== undefined && revision !== this.#fillRevision)
            await this.delete([prefixedKey]);
        } catch (failure) {
          if (background !== undefined && unit !== undefined)
            placeSetFailure(background.origin, failure, unit, background);
          throw failure;
        }
      },
      options.ttl
    );
  }

  /**
   * Delete a specific key (and its revalidating key)
   * @param key - Cache key (will be prefixed automatically)
   */
  async _delete(key: string, origin?: object): Promise<void> {
    const prefixedKey = this.#prefixKey(key);
    return this.#deletePrefixed(prefixedKey, origin);
  }

  /**
   * Clear cache by prefix or all within the public unscoped namespace.
   * @param prefix - Optional prefix to clear (will be prefixed automatically)
   */
  async _clear(prefix?: string, origin?: object): Promise<void> {
    const prefixedPrefix = this.#prefixKey(prefix ?? "");
    return this.#clearPrefixed(prefixedPrefix, origin);
  }

  /**
   * Mark entry as revalidating (for SWR coordination)
   * Returns true if this caller should perform revalidation
   * @param key - Cache key (will be prefixed automatically)
   */
  async _markRevalidating(key: string): Promise<boolean> {
    return this.#markRevalidatingScoped(key);
  }

  async #markRevalidatingScoped(
    key: string,
    namespace?: string
  ): Promise<boolean> {
    const revalidatingKey = `${this.#prefixKey(key, namespace)}${REVALIDATING_SUFFIX}`;

    // Check if already revalidating
    const existing = await this.get(revalidatingKey);
    if (existing && this.clock.now() - existing.createdAt < existing.ttl)
      return false;

    // Set revalidating flag with short TTL
    const entry: CacheEntry<boolean> = {
      value: true,
      createdAt: this.clock.now(),
      ttl: REVALIDATING_TTL_MS,
    };
    await this.set(revalidatingKey, REVALIDATING_TTL_MS, entry);

    return true;
  }

  /**
   * Clear revalidating flag
   * @param key - Cache key (will be prefixed automatically)
   */
  async _clearRevalidating(key: string): Promise<void> {
    return this.#clearRevalidatingScoped(key);
  }

  async #clearRevalidatingScoped(
    key: string,
    namespace?: string
  ): Promise<void> {
    const revalidatingKey = `${this.#prefixKey(key, namespace)}${REVALIDATING_SUFFIX}`;
    await this.delete([revalidatingKey]);
  }

  /**
   * Invalidate cache entries after a mutation
   * @param modelName - The model name for auto-invalidation
   * @param options - Cache invalidation options
   */
  async _invalidate(
    modelName: string,
    options?: CacheInvalidationOptions,
    origin?: object
  ): Promise<void> {
    return this.#invalidateScoped(modelName, options, origin);
  }

  async #invalidateScoped(
    modelName: string,
    options?: CacheInvalidationOptions,
    origin?: object,
    namespace?: string
  ): Promise<void> {
    if (!hasCacheInvalidationWork(options)) return;
    this.#fillRevision += 1;
    const targets: PreparedInvalidationTarget[] = [];
    if (options === undefined || options.autoInvalidate === true) {
      targets.push({
        kind: "clear",
        prefixedKey: this.#prefixKey(
          namespace === undefined ? `${modelName}:` : "",
          namespace
        ),
      });
    }
    if (options?.invalidate) {
      for (const entry of options.invalidate) {
        const isPrefix = entry.endsWith("*");
        const key = isPrefix ? entry.slice(0, -1) : entry;
        targets.push({
          kind: isPrefix ? "clear" : "delete",
          prefixedKey: this.#prefixKey(key, namespace),
        });
      }
    }
    return cacheStep("invalidate", origin, this.driverName, async (unit) => {
      const promises: Promise<void>[] = [];
      for (const target of targets) {
        promises.push(
          target.kind === "clear"
            ? this.#clearPrefixed(target.prefixedKey, unit)
            : this.#deletePrefixed(target.prefixedKey, unit)
        );
      }
      await Promise.all(promises);
    });
  }

  /**
   * Optional: connect to cache backend
   */
  connect?(): Promise<void>;

  /**
   * Optional: disconnect from cache backend
   */
  disconnect?(): Promise<void>;

  // ============================================================
  // INTERNAL HELPERS
  // ============================================================

  #deletePrefixed(prefixedKey: string, origin?: object): Promise<void> {
    this.#fillRevision += 1;
    const keys = [prefixedKey, `${prefixedKey}${REVALIDATING_SUFFIX}`];
    return cacheStep("delete", origin, this.driverName, () =>
      this.delete(keys)
    );
  }

  #clearPrefixed(prefixedKey: string, origin?: object): Promise<void> {
    this.#fillRevision += 1;
    return cacheStep("clear", origin, this.driverName, () =>
      this.clear(prefixedKey)
    );
  }

  /**
   * Prefix a public storage key, or rebase an official relative key into its
   * authenticated extension namespace.
   *
   * An EMPTY relative key is the whole scope — `$invalidate("*")` — and it
   * rebases to `<scope>:`, WITH the separator, because the storage backends
   * clear by `startsWith`. A bare `<scope>` would also match every sibling scope
   * whose namespace string merely extends this one, and one axis of the scope
   * grammar can do that: the cache `version` is the last component and its `s:`
   * body is variable-length, so `version: "a"` is a strict prefix of
   * `version: "ab"` at the same dialect and namespace. That axis is exactly what
   * §7.1 leaves users to partition SQLite and unbound MySQL databases with, so a
   * clear-all crossing it would empty a physically different database's entries.
   *
   * Adding the separator loses nothing: every key this scope can hold is written
   * through `#executeCached`, whose relative key is always
   * `<model>:<operation>:<hash>`, so no stored key is ever equal to the bare
   * scope. The unscoped arm below deliberately keeps its bare `viborm` root — a
   * public caller CAN store at exactly that key, there is only one such root,
   * and no sibling exists for a clear to cross into.
   */
  #prefixKey(key: string, namespace?: string): string {
    if (namespace !== undefined) {
      if (key.startsWith(`${CACHE_PREFIX}:`)) {
        throw new CacheInvalidKeyError(
          "Official cache keys and prefixes must be relative and cannot begin with 'viborm:'."
        );
      }
      return `${namespace}:${key}`;
    }

    const prefixedKey = key.startsWith(`${CACHE_PREFIX}:`)
      ? key
      : key
        ? `${CACHE_PREFIX}:${key}`
        : CACHE_PREFIX;
    if (
      prefixedKey === OFFICIAL_CACHE_NAMESPACE_ROOT ||
      prefixedKey.startsWith(`${OFFICIAL_CACHE_NAMESPACE_ROOT}:`)
    ) {
      throw new CacheInvalidKeyError(
        "The official cache namespace requires an authenticated cache extension."
      );
    }
    return prefixedKey;
  }
}

/** Serve one official read: the extension's seam, absent from the package barrel. */
export function serveOfficialRead<T>(
  cache: CacheDriver,
  request: CacheServe<T>
): Promise<T> {
  return serveFriend(cache, request);
}

/** Invalidate inside one official namespace: absent from the package barrel. */
export function invalidateOfficialCache(
  cache: CacheDriver,
  options: CacheInvalidationOptions | undefined,
  origin: object | undefined,
  namespace: string
): Promise<void> {
  return invalidateFriend(cache, options, origin, namespace);
}
