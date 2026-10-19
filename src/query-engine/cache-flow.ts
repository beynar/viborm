import type { CacheDriver, CacheExecutionOptions } from "@cache/driver";
import {
  type DetachedCacheResultCodec,
  executeCachedWithResultCodec,
  invalidateOfficialCache,
  type WaitUntilFn,
} from "@cache/driver";
import { stableStringify } from "@cache/key";
import {
  type CacheInvalidationOptions,
  cacheInvalidationSchema,
  type WithCacheOptions,
  withCacheSchema,
} from "@cache/schema";
import type { DriverIdentity } from "@drivers/driver-identity";
import type { QueryExecutionContext } from "@drivers/exports";
import {
  CacheConfigurationError,
  CacheOperationNotCacheableError,
} from "@errors";
import { isAdmittedRows, isImmutableRowData } from "@extensions/admission";
import type { ResolvedExtensionChain } from "@extensions/chain";
import type { RowsContribution } from "@extensions/controls";
import {
  type AdmittedControls,
  isStableControlValue,
} from "@extensions/controls";
import type { WriteOutcomeRegistration } from "@extensions/query";
import { admittedRowsOf, isLazy } from "@extensions/rows";
import type { LazyRelations } from "@query-engine/raptor3/shared/row-scope";
import type { Input } from "@query-engine/raptor3/shared/schema";
import { parse } from "@validation";
import { readValidationFailureCause } from "@validation/parse-failure";
import { sha256 } from "@validation/primitives/sha256";
import { isRecord } from "@validation/value-guards";
import { errorCause } from "../errors/diagnostic-safety";
import { isWriteOperation } from "./routed-operations";

const CACHEABLE_OPERATIONS: Set<string> = new Set([
  "findFirst",
  "findMany",
  "findUnique",
  "findUniqueOrThrow",
  "findFirstOrThrow",
  "count",
  "aggregate",
  "groupBy",
  "exist",
]);

/** Every option object the cache's control admitted, for its typed read. */
const admittedMutationOptions = new WeakMap<object, CacheInvalidationOptions>();

/**
 * The cache's own parser, run by core's control admission (the declaration is
 * `officialCacheControls` in `@cache/capability`). `parse` returns a thrown
 * validator as issues, so every refusal here is one `CacheConfigurationError`.
 */
export function admitMutationCacheOptions(
  cache: unknown
): CacheInvalidationOptions {
  const parsed = parse(cacheInvalidationSchema, cache);
  if (parsed.issues) {
    throw new CacheConfigurationError(
      `Invalid mutation cache options: ${parsed.issues.map((issue) => issue.message).join(", ")}`,
      { cause: readValidationFailureCause(parsed) }
    );
  }
  const invalidate =
    parsed.value.invalidate === undefined
      ? undefined
      : [...parsed.value.invalidate];
  // Deeply frozen: admission keeps an immutable value as it is, so this
  // object stays the one the WeakMap below finds.
  if (invalidate) Object.freeze(invalidate);
  const options: CacheInvalidationOptions = Object.freeze({
    autoInvalidate: parsed.value.autoInvalidate,
    ...(invalidate === undefined ? {} : { invalidate }),
  });
  admittedMutationOptions.set(options, options);
  return options;
}

/** The mutation options a call's `cache` control admitted, if it gave one. */
export function readMutationCacheOptions(
  controls: AdmittedControls | undefined
): CacheInvalidationOptions | undefined {
  const admitted = controls?.cache;
  return isRecord(admitted) ? admittedMutationOptions.get(admitted) : undefined;
}

/**
 * What one cached read is keyed on. A read that admitted no control keeps
 * today's key, the prepared arguments byte for byte; otherwise the key is the
 * pair of those arguments and the admitted controls, which no base key can
 * spell (its arguments are always an object), and, on a chain with `rows`,
 * those declarations themselves, since the same control value selects
 * different rows under different declarations. A control value that is not
 * plain data has no canonical form: `undefined` bypasses the cache.
 */
export function cacheKeyOf(
  args: Record<string, unknown>,
  controls: AdmittedControls | undefined,
  rows: ResolvedExtensionChain["rows"]
): unknown {
  if (controls === undefined) return args;
  // Only values admission fixed key a cache entry: the rows the read's SQL
  // binds were bound from those same values (`snapshotControlValue` in controls.ts).
  if (!Object.values(controls).every(isStableControlValue)) return undefined;
  if (rows === undefined) return [args, controls];
  try {
    return [args, controls, rows.map(rowsIdentity)];
  } catch {
    // A rows member compiled on first use could not settle (a model it
    // refuses): the read goes uncached, and fails only if it needs that
    // model itself.
    return undefined;
  }
}

export { isCacheManagedExecution } from "@cache/capability";

/** Prepare the cache listener consumed by the shared write-outcome rail. */
export function prepareMutationCacheWriteOutcome(
  cache: CacheDriver,
  modelName: string,
  operation: string,
  options: CacheInvalidationOptions | undefined,
  context: QueryExecutionContext,
  officialScope: object
): WriteOutcomeRegistration | undefined {
  if (!isWriteOperation(operation)) return undefined;

  return Object.freeze({
    extension: "viborm.cache",
    failurePolicy: "boundary-owned",
    listener: async (outcome) => {
      try {
        await invalidateOfficialCache(
          cache,
          modelName,
          options,
          context,
          officialScope
        );
      } catch (error) {
        throw new CacheConfigurationError(
          `Cache invalidation failed after mutation '${operation}' on model '${modelName}'.`,
          {
            cause: errorCause(error),
            meta: {
              method: "invalidate",
              model: modelName,
              operation,
              commitCertainty: outcome.certainty,
            },
          }
        );
      }
    },
  });
}

export function validateCacheableOperation(operation: string): void {
  if (CACHEABLE_OPERATIONS.has(operation)) {
    return;
  }

  throw new CacheOperationNotCacheableError(operation, [
    ...CACHEABLE_OPERATIONS,
  ]);
}

export function createCacheExecutionOptions(
  config: WithCacheOptions | undefined,
  waitUntil: WaitUntilFn | undefined,
  driverIdentity: DriverIdentity | undefined
): CacheExecutionOptions {
  const parsed = parse(withCacheSchema, config);
  if (parsed.issues) {
    throw new CacheConfigurationError(
      `Invalid cache options: ${parsed.issues.map((issue) => issue.message).join(", ")}`,
      { cause: readValidationFailureCause(parsed) }
    );
  }

  const { bypass, key, ttl, swr } = parsed.value;

  return {
    ttlMs: ttl,
    swr: resolveSwr(swr, ttl),
    bypass,
    key,
    waitUntil,
    driverIdentity,
  };
}

/**
 * The detached cache representation of one read result: the cache driver's
 * own contract, read here at the boundary that hands the Raptor 3 route's
 * `cacheCodec` to it.
 */
export type CacheResultCodec = DetachedCacheResultCodec<unknown>;

/** Execute an official read through the detached result representation. */
export function executeCachedResultOperation(
  cache: CacheDriver,
  modelName: string,
  operation: string,
  args: unknown,
  executor: () => Promise<unknown>,
  options: CacheExecutionOptions,
  codec: CacheResultCodec,
  officialScope: object
): Promise<unknown> {
  return executeCachedWithResultCodec(
    cache,
    modelName,
    operation,
    args,
    executor,
    options,
    codec,
    officialScope
  );
}

export async function invalidateManualCache(
  cache: CacheDriver,
  keys: string[],
  context: QueryExecutionContext | undefined,
  officialScope: object
): Promise<void> {
  const invalidate = [...keys];
  const options = Object.freeze({ invalidate });
  await invalidateOfficialCache(
    cache,
    "manual",
    options,
    context,
    officialScope
  );
}

function resolveSwr(
  swr: boolean | number | undefined,
  ttlMs: number
): number | false {
  if (swr === undefined || swr === false) {
    return false;
  }
  if (swr === true) {
    return ttlMs * 2;
  }
  return ttlMs + swr;
}

/** What admission leaves in place of a lazy entry's predicate: its resolver. */
type Lazy<T> = () => T;

/**
 * `rows` with every lazy entry resolved, for what reads the definition as a
 * whole (a cache key): the same object when it names none. Resolving one
 * compiles it, so this is never on a call's own path.
 */
const settled = new WeakMap<RowsContribution, RowsContribution>();
function settledRows(rows: RowsContribution): RowsContribution {
  const lazyCycles = Object.values(rows.verbs ?? {}).some(
    (entry) =>
      typeof entry !== "function" &&
      typeof entry.acyclic === "object" &&
      !Array.isArray(entry.acyclic)
  );
  if (!(isLazy(rows) || lazyCycles)) return rows;
  const known = settled.get(rows);
  if (known) return known;
  const verbs = Object.fromEntries(
    Object.entries(rows.verbs!).map(([model, entry]) => {
      const resolved = typeof entry === "function" ? entry() : entry;
      const acyclic = resolved.acyclic as
        | readonly string[]
        | LazyRelations
        | undefined;
      return [
        model,
        acyclic === undefined || Array.isArray(acyclic)
          ? resolved
          : Object.freeze({
              ...resolved,
              acyclic: (acyclic as LazyRelations).resolve(),
            }),
      ];
    })
  );
  const models = Object.fromEntries(
    Object.entries(rows.models).map(([model, modes]) => [
      model,
      Object.fromEntries(
        Object.entries(modes).map(([mode, purposes]) => [
          mode,
          Object.fromEntries(
            Object.entries(purposes).map(([purpose, where]) => [
              purpose,
              typeof where === "function" ? (where as Lazy<Input>)() : where,
            ])
          ),
        ])
      ),
    ])
  );
  const result = Object.freeze({ ...rows, models, verbs });
  settled.set(rows, result);
  return result;
}

/**
 * A `rows` member as a cache key holds it: everything it says, every lazy
 * entry resolved (a cache shared across isolates must tell two policies apart
 * by content). For rows admission owns and nobody can change, a SHA-256
 * digest computed once; other rows are keyed by their content, read afresh.
 */
const identities = new WeakMap<RowsContribution, string>();
function rowsIdentity(chained: RowsContribution): unknown {
  const rows = admittedRowsOf(chained);
  const known = identities.get(rows);
  if (known !== undefined) return known;
  const settled = settledRows(rows);
  // Memoised only where nothing it says can change: rows admission owns, and
  // every entry they resolved to deeply frozen.
  if (
    !(
      isAdmittedRows(rows) &&
      Object.values(settled.verbs ?? {}).every((entry) =>
        isImmutableRowData(entry)
      )
    )
  )
    return settled;
  const digest = sha256(new TextEncoder().encode(stableStringify(settled)));
  const identity = Array.from(digest, (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  identities.set(rows, identity);
  return identity;
}
