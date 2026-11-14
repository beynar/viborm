/**
 * VibORM's cache, written with the public extension contract:
 * `client.$extends(cache({ driver }))`.
 *
 * - `$withCache(options)` binds the view's read options (`cacheRead`, a
 *   bound argument): what marks a read the cache serves.
 * - A read through that view is served closest to the core (`inner`), keyed
 *   on the prepared call (`key(run)`), and run uncached when it has no key
 *   or runs in a transaction or an array.
 * - A write invalidates the scope once durable (`settled`), as its own
 *   `cache` argument says; `$invalidate` once the view's work is durable.
 * - The scope is a pure function of the cache `version` and the database the
 *   call works against (`database`), so two clients of one database share
 *   entries and two databases never do.
 */
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { MutationOperations } from "../client/exports";
import { VibORMError } from "../errors/base";
import { CacheConfigurationError } from "../errors/cache";
import { accepts, args, bound } from "../extensions/args";
import { around, call } from "../extensions/call";
import { codec } from "../extensions/codec";
import { type Database, database } from "../extensions/database";
import { extension } from "../extensions/extension";
import { key } from "../extensions/key";
import { methods } from "../extensions/methods-part";
import { reads, target, writes } from "../extensions/on";
import { settled } from "../extensions/settled";
import type {
  AnyTarget,
  Extension,
  Facts,
  PlacedArgument,
  Run,
} from "../index";
import { CacheDriver, INVALIDATE, SERVE, type WaitUntilFn } from "./driver";
import { createOfficialCacheNamespace } from "./key";
import { cacheCodec } from "./result-codec";
import {
  admitMutationOptions,
  admitReadOptions,
  type CacheInvalidationOptions,
  type CacheReadOptions,
  hasCacheInvalidationWork,
  validateCacheableOperation,
  type WithCacheOptions,
} from "./schema";

export interface CacheExtensionConfig {
  readonly driver: CacheDriver;
  readonly version?: string | number;
  readonly waitUntil?: WaitUntilFn;
}

type ConfigKeys<Config> = Config extends unknown ? keyof Config : never;

type ExactCacheExtensionConfig<Config> = Record<
  Exclude<ConfigKeys<Config>, keyof CacheExtensionConfig>,
  never
>;

/** What the cache adds to a client: its `cache` argument on writes, `$withCache`, `$invalidate`. */
export type CacheFacts = Facts<
  Record<never, never>,
  Record<never, never>,
  {
    readonly cache: PlacedArgument<
      CacheInvalidationOptions,
      PropertyKey,
      MutationOperations
    >;
  },
  never,
  never,
  Record<never, never>,
  Record<never, never>,
  false,
  true
>;

/** A validator as a Standard Schema: what an argument of the cache is checked by. */
const validator = <T>(admit: (value: unknown) => T): StandardSchemaV1<T> => ({
  "~standard": {
    version: 1,
    vendor: "viborm.cache",
    validate: (value: unknown) => ({ value: admit(value) }),
  },
});

function configurationError(message: string): never {
  throw new CacheConfigurationError(message);
}

/** The cache's view of one read: what its moment one leaves its second. */
interface Values {
  readonly cache?: CacheInvalidationOptions;
  readonly cacheRead?: CacheReadOptions;
}

/**
 * VibORM's fixed-name cache extension: `client.$extends(cache({ driver }))`.
 */
export function cache<T extends AnyTarget, const Config>(
  config: Config &
    NoInfer<CacheExtensionConfig & ExactCacheExtensionConfig<Config>>
): Extension<T, CacheFacts>;
export function cache(config: CacheExtensionConfig): unknown {
  const { driver, version, waitUntil } = config;
  if (!(driver instanceof CacheDriver))
    configurationError(
      "Cache extension configuration requires a CacheDriver instance."
    );
  if (
    version !== undefined &&
    !(
      typeof version === "string" ||
      (typeof version === "number" && Number.isFinite(version))
    )
  )
    configurationError(
      'Cache extension configuration "version" must be a string or finite number.'
    );
  if (waitUntil !== undefined && typeof waitUntil !== "function")
    configurationError(
      'Cache extension configuration "waitUntil" must be a function.'
    );

  // Pure in its facts: the same version and database always give one scope.
  const namespaces = new Map<string, string>();
  const namespaceOf = ({ dialect, namespace }: Database): string => {
    const id = JSON.stringify([dialect, namespace ?? null]);
    let scope = namespaces.get(id);
    if (scope === undefined) {
      scope = createOfficialCacheNamespace({ version, dialect, namespace });
      namespaces.set(id, scope);
    }
    return scope;
  };
  const invalidate = (
    origin: object,
    options: CacheInvalidationOptions | undefined
  ) => driver[INVALIDATE]("", options, origin, namespaceOf(database(origin)));

  return extension(
    "viborm.cache",
    args({
      // A write's own invalidation options.
      cache: accepts(validator(admitMutationOptions)).on(writes),
      // Only `$withCache` binds it: the mark of a read the cache serves.
      cacheRead: bound(validator(admitReadOptions)),
    }),

    // Writes: none through the read view; the scope is invalidated once the
    // write is durable.
    call((c) => {
      const values: Values = c.values;
      if (values.cacheRead !== undefined)
        validateCacheableOperation(c.operation);
      const options = values.cache;
      if (!hasCacheInvalidationWork(options)) return;
      settled(c, async ({ certainty }) => {
        try {
          await invalidate(c, options);
        } catch (cause) {
          throw new CacheConfigurationError(
            `Cache invalidation failed after mutation '${c.operation}' on model '${c.model}'.`,
            {
              cause: cause instanceof Error ? cause : undefined,
              meta: {
                method: "invalidate",
                model: c.model,
                operation: c.operation,
                commitCertainty: certainty,
              },
            }
          );
        }
      });
    }, target(writes)),

    // Reads through the view: answered from the store, closest to the core,
    // so every other part sees each call and the core's answer is stored.
    around(
      (c) => {
        const values: Values = c.values;
        const read = values.cacheRead;
        const model = c.model;
        if (read === undefined || model === undefined) return;
        return <R>(run: Run<unknown, R>): Promise<R> => {
          // A transaction's and an array's reads see their own writes.
          if (run.mode !== "direct") return run();
          const id = key(run);
          if (id === undefined) return run();
          const db = database(run);
          return driver[SERVE]({
            id,
            codec: cacheCodec(codec(run), c.operation),
            read,
            namespace: namespaceOf(db),
            waitUntil,
            model,
            operation: c.operation,
            origin: run,
            database: db,
          });
        };
      },
      target(reads),
      { inner: true }
    ),

    methods((scope) => ({
      $withCache: (options?: WithCacheOptions) =>
        scope.$bind({ cacheRead: options }),
      $invalidate: (...keys: string[]) =>
        settled(scope, async () => {
          try {
            await invalidate(scope, { invalidate: keys });
          } catch (cause) {
            // A refused key is said as it is; a backend failure is the
            // cache's, as a write's invalidation failure is.
            if (cause instanceof VibORMError) throw cause;
            throw new CacheConfigurationError("Cache invalidation failed.", {
              cause: cause instanceof Error ? cause : undefined,
              meta: { method: "invalidate" },
            });
          }
        }),
    }))
  );
}
