import { CacheConfigurationError } from "@errors";
import type { ResolvedExtensionChain } from "@extensions/chain";
import type {
  GenericQueryHandler,
  OfficialGenericQueryHandler,
} from "@extensions/query";
import {
  isFunction,
  isNumber,
  isRecord,
  isString,
} from "@validation/value-guards";
import { isError } from "../errors/diagnostic-safety";
import type { WaitUntilFn } from "./cache-contract";
import { CacheDriver, createOfficialCacheScope } from "./driver";
import { createOfficialCacheNamespace } from "./key";

export const OFFICIAL_CACHE_NAME = "viborm.cache";

/** The exact official query contribution. It is recognized by identity. */
export type OfficialCacheQueryContribution = OfficialGenericQueryHandler & {
  bind(thisArg: unknown): GenericQueryHandler;
};

/** The official value accepted by the dedicated `$extends` overload. */
export type OfficialCacheExtension = {
  readonly name: typeof OFFICIAL_CACHE_NAME;
  readonly query: OfficialCacheQueryContribution;
};

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

/**
 * What `cache()` knows before it meets a client: no scope, because the scope
 * partitions on facts (dialect, SQL namespace) that only a concrete driver
 * carries. One definition may be appended to several clients.
 */
interface OfficialCacheDefinitionCapability {
  readonly driver: CacheDriver;
  readonly version: string | number | undefined;
  readonly waitUntil: WaitUntilFn | undefined;
}

/** The definition once bound to one client's driver, gaining its scope. */
interface OfficialCacheCapability extends OfficialCacheDefinitionCapability {
  readonly scope: object;
}

/**
 * The two driver facts the scope derives from. Structural, so the cache holds
 * no driver reference and no import edge back into `src/drivers`.
 */
export interface OfficialCacheBindTarget {
  readonly dialect: string;
  readonly adapter: { readonly namespace?: string | undefined };
}

const capabilitiesByQuery = new WeakMap<
  CallableFunction,
  OfficialCacheDefinitionCapability
>();
const definitionsByChain = new WeakMap<
  ResolvedExtensionChain,
  OfficialCacheDefinitionCapability
>();
const capabilitiesByChain = new WeakMap<
  ResolvedExtensionChain,
  OfficialCacheCapability
>();

function configurationCause(cause: unknown): Error {
  return isError(cause)
    ? cause
    : new Error("A non-Error value was thrown.", { cause });
}

function configurationError(message: string, cause?: unknown): never {
  throw new CacheConfigurationError(message, {
    cause: cause === undefined ? undefined : configurationCause(cause),
  });
}

function isCacheDriver(value: unknown): value is CacheDriver {
  try {
    return value instanceof CacheDriver;
  } catch (cause) {
    configurationError(
      "Cache extension driver capability could not be inspected.",
      cause
    );
  }
}

function snapshotConfig(value: unknown): OfficialCacheDefinitionCapability {
  if (!isRecord(value)) {
    configurationError("Cache extension configuration must be an object.");
  }
  let keys: PropertyKey[];
  try {
    keys = Reflect.ownKeys(value);
  } catch (cause) {
    configurationError(
      "Cache extension configuration could not be inspected.",
      cause
    );
  }
  for (const key of keys) {
    if (
      typeof key !== "string" ||
      (key !== "driver" && key !== "version" && key !== "waitUntil")
    ) {
      configurationError(
        `Cache extension configuration has unknown member "${String(key)}".`
      );
    }
  }

  const read = (key: "driver" | "version" | "waitUntil"): unknown => {
    if (!keys.includes(key)) return undefined;
    try {
      return value[key];
    } catch (cause) {
      configurationError(
        `Cache extension configuration member "${key}" could not be read.`,
        cause
      );
    }
  };

  const driver = read("driver");
  const version = read("version");
  const waitUntil = read("waitUntil");
  if (!isCacheDriver(driver)) {
    configurationError(
      "Cache extension configuration requires a CacheDriver instance."
    );
  }
  if (
    version !== undefined &&
    !(isString(version) || (isNumber(version) && Number.isFinite(version)))
  ) {
    configurationError(
      'Cache extension configuration "version" must be a string or finite number.'
    );
  }
  if (waitUntil !== undefined && !isFunction<WaitUntilFn>(waitUntil)) {
    configurationError(
      'Cache extension configuration "waitUntil" must be a function.'
    );
  }
  return Object.freeze({ driver, version, waitUntil });
}

/** Create VibORM's fixed-name cache extension. */
export function cache<const Config>(
  config: Config &
    NoInfer<CacheExtensionConfig & ExactCacheExtensionConfig<Config>>
): OfficialCacheExtension;
export function cache(config: CacheExtensionConfig): unknown {
  const capability = snapshotConfig(config);
  const query: GenericQueryHandler = ({ proceed }) => proceed();
  capabilitiesByQuery.set(query, capability);
  return Object.freeze({ name: OFFICIAL_CACHE_NAME, query });
}

export function getOfficialCacheQueryCapability(
  query: unknown
): OfficialCacheDefinitionCapability | undefined {
  return isFunction(query) ? capabilitiesByQuery.get(query) : undefined;
}

/**
 * The definition carried by this chain, scope or no scope. Generic
 * extension-chain code sees only this: admission, duplicate refusal, and
 * propagation are all decisions about the DEFINITION, and none of them may
 * depend on whether a client has bound it yet.
 */
export function getOfficialCacheChainDefinition(
  chain: ResolvedExtensionChain | undefined
): OfficialCacheDefinitionCapability | undefined {
  return chain === undefined ? undefined : definitionsByChain.get(chain);
}

/** The bound capability: present only after a client composition root bound it. */
export function getOfficialCacheChainCapability(
  chain: ResolvedExtensionChain | undefined
): OfficialCacheCapability | undefined {
  return chain === undefined ? undefined : capabilitiesByChain.get(chain);
}

export function registerOfficialCacheChain(
  chain: ResolvedExtensionChain,
  capability: OfficialCacheDefinitionCapability
): void {
  definitionsByChain.set(chain, capability);
}

/**
 * Bind one resolved chain's cache definition to the concrete client driver,
 * deriving the scope that partitions its storage.
 *
 * Called by the client composition root — the one place that holds both the
 * resolved chain and the driver — and only for a chain that carries the
 * official cache, so an ordinary extension costs nothing here.
 *
 * The derivation is pure, so appending another extension re-derives the SAME
 * namespace: the scope is retained by value, with no registry keyed on chain
 * identity to keep in step and no second scope to split the cache.
 */
export function bindOfficialCacheChain(
  chain: ResolvedExtensionChain,
  target: OfficialCacheBindTarget
): void {
  const definition = definitionsByChain.get(chain);
  if (definition === undefined) return;
  capabilitiesByChain.set(
    chain,
    Object.freeze({
      driver: definition.driver,
      version: definition.version,
      waitUntil: definition.waitUntil,
      scope: createOfficialCacheScope(
        createOfficialCacheNamespace({
          version: definition.version,
          dialect: target.dialect,
          namespace: target.adapter.namespace,
        })
      ),
    })
  );
}
