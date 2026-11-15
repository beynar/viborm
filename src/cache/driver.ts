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
  type Backend,
  REVALIDATING_SUFFIX,
  scheduleBackground,
} from "./cache-background";
import { CACHE_PREFIX, fastHash } from "./key";
import {
  type CacheInvalidationOptions,
  type CacheReadOptions,
  hasCacheInvalidationWork,
} from "./schema";
import { cacheOutcome, cacheStep, placeSetFailure } from "./units";

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
interface CacheServe<T> {
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
  /** What refreshes a stale entry: `staleWhileRevalidate`, when the cache was given it. */
  readonly revalidate?: Revalidate | undefined;
}

/**
 * One stale entry, as the driver hands it over: its read, its entry and
 * age, its prefixed key and the driver's backend (what the marker that
 * claims a refresh uses), and the store of the new rows.
 */
export interface Refresh {
  readonly request: CacheServe<unknown>;
  readonly entry: CacheEntry<unknown>;
  readonly now: number;
  readonly key: string;
  readonly backend: Backend;
  store(stored: unknown): Promise<void>;
}

/**
 * Whether a stale entry is served while it is refreshed in the background:
 * what `swr` brings, so a cache without it carries none of it.
 */
export type Revalidate = (refresh: Refresh) => boolean;

/**
 * The keys of the two methods a driver serves its extension with: one read
 * through the store, and a namespace's invalidation. No package entry
 * exports them, so only the cache's own extension calls them.
 */
export const SERVE = Symbol("serve");
export const INVALIDATE = Symbol("invalidate");

/**
 * The keys of the steps on a prefixed key the driver owns, observed as
 * `cache` units: what its extension and the unscoped storage functions
 * (`storage.ts`, which an application that never calls them does not carry)
 * reach. No package entry exports them either.
 */
export const GET = Symbol("get");
export const SET = Symbol("set");
export const DROP = Symbol("drop");
export const BACKEND = Symbol("backend");

/** How a key is dropped: the entries under it, or the one entry it names. */
type Drop = "clear" | "delete";

/**
 * A relative key rebased into an official scope. An EMPTY relative key is
 * the whole scope — `$invalidate("*")` — and it rebases to `<scope>:`, WITH
 * the separator, because the storage backends clear by `startsWith`. A bare
 * `<scope>` would also match every sibling scope whose namespace string
 * merely extends this one, and one axis of the scope grammar can do that:
 * the cache `version` is the last component and its `s:` body is
 * variable-length, so `version: "a"` is a strict prefix of `version: "ab"`
 * at the same dialect and namespace. That axis is exactly what §7.1 leaves
 * users to partition SQLite and unbound MySQL databases with, so a
 * clear-all crossing it would empty a physically different database's
 * entries. Adding the separator loses nothing: every key this scope can hold
 * is `<model>:<operation>:<hash>`, so no stored key is ever equal to the
 * bare scope.
 */
export function scopedKey(namespace: string, key: string): string {
  if (key.startsWith(`${CACHE_PREFIX}:`)) {
    throw new CacheInvalidKeyError(
      "Official cache keys and prefixes must be relative and cannot begin with 'viborm:'."
    );
  }
  return `${namespace}:${key}`;
}

/**
 * Abstract base class for cache drivers.
 *
 * Follows the same pattern as the database Driver class:
 * - Protected abstract methods for concrete implementations (non-underscored)
 * - Symbol-keyed steps handle prefixed keys, instrumentation, and delegation
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

  async [SERVE]<T>(request: CacheServe<T>): Promise<T> {
    const { id, read, namespace, codec, model, operation, origin } = request;
    const cacheKey = scopedKey(
      namespace,
      `${model}:${operation}:${fastHash(id)}${read.key === undefined ? "" : `:${read.key}`}`
    );
    const identity = JSON.stringify([id, read.key]);
    const revision = this.#fillRevision;
    const store = (stored: unknown, background?: CacheServe<unknown>) =>
      this[SET](
        cacheKey,
        stored,
        { ttl: read.ttlMs, swrTtl: read.swr || undefined },
        origin,
        background,
        identity,
        revision
      );
    let outcome = "bypass";
    if (!read.bypass) {
      const cached = await this[GET]<unknown>(cacheKey, origin);
      // Read as the backend gives it: an entry of another identity, or whose
      // times are not a finite span, is a miss.
      if (cached?.identity === identity) {
        const { createdAt, ttl, expiresAt } = cached;
        if (
          [createdAt, ttl, expiresAt].every(Number.isFinite) &&
          ttl > 0 &&
          expiresAt! >= createdAt
        ) {
          const value = codec.materialize(cached.value);
          const now = this.clock.now();
          if (now - createdAt < ttl) {
            note(origin, cacheOutcome("hit"));
            return value;
          }
          if (
            request.revalidate?.({
              request,
              entry: cached,
              now,
              key: cacheKey,
              backend: this[BACKEND](),
              store,
            })
          )
            return value;
        }
      }
      outcome = "miss";
    }
    const result = await codec.run();
    if (revision === this.#fillRevision) {
      try {
        // The observed set unit presents a failure, which the background
        // promise then holds.
        scheduleBackground(store(codec.snapshot(), request), request.waitUntil);
      } catch (error) {
        note(origin, cacheOutcome("miss", "cache-set-failed", error));
      }
    }
    note(origin, cacheOutcome(outcome));
    return result;
  }

  // ============================================================
  // STEPS - on prefixed keys, observed as `cache` units
  // ============================================================

  async [GET]<T>(
    prefixedKey: string,
    origin?: object
  ): Promise<CacheEntry<T> | null> {
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

  async [SET]<T>(
    prefixedKey: string,
    value: T,
    options: CacheSetOptions,
    origin?: object,
    /** The read a background set belongs to, whose outcomes a failure joins. */
    background?: CacheServe<unknown>,
    identity?: string,
    revision?: number
  ): Promise<void> {
    if (revision !== undefined && revision !== this.#fillRevision) return;
    // Use SWR TTL if provided, otherwise just use regular TTL
    const storageTtl = options.swrTtl ?? options.ttl;
    const createdAt = this.clock.now();
    const entry: CacheEntry<T> = {
      value,
      createdAt,
      ttl: options.ttl,
      ...(identity === undefined
        ? {}
        : { identity, expiresAt: createdAt + storageTtl }),
    };

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

  /** The backend's own primitives, unobserved, and the clock. */
  [BACKEND](): Backend {
    return {
      get: (key) => this.get(key),
      set: (key, ttl, entry) => this.set(key, ttl, entry),
      delete: (keys) => this.delete(keys),
      now: () => this.clock.now(),
    };
  }

  /**
   * Invalidate after a mutation: the entries under `prefix` (relative keys
   * rebased by `prefixed`), and the targets `options` names.
   */
  async [INVALIDATE](
    prefix: string,
    options: CacheInvalidationOptions | undefined,
    origin: object | undefined,
    prefixed: (key: string) => string
  ): Promise<void> {
    if (!hasCacheInvalidationWork(options)) return;
    this.#fillRevision += 1;
    // Every target is rebased, and so validated, before any is dropped.
    const targets: [Drop, string][] =
      options === undefined || options.autoInvalidate === true
        ? [["clear", prefixed(prefix)]]
        : [];
    for (const entry of options?.invalidate ?? [])
      targets.push(
        entry.endsWith("*")
          ? ["clear", prefixed(entry.slice(0, -1))]
          : ["delete", prefixed(entry)]
      );
    return cacheStep("invalidate", origin, this.driverName, async (unit) => {
      await Promise.all(
        targets.map(([drop, key]) => this[DROP](drop, key, unit))
      );
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

  /**
   * Drop the entries under `prefixedKey` (`clear`), or that entry and its
   * revalidation marker (`delete`). Not `async`: a step that fails is
   * rejected by the promise the caller holds, with no promise between them
   * left a tick without a handler (workerd reports one).
   */
  [DROP](drop: Drop, prefixedKey: string, origin?: object): Promise<void> {
    this.#fillRevision += 1;
    return cacheStep(drop, origin, this.driverName, () =>
      drop === "clear"
        ? this.clear(prefixedKey)
        : this.delete([prefixedKey, `${prefixedKey}${REVALIDATING_SUFFIX}`])
    );
  }
}
