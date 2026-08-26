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

interface OfficialCacheCapability {
  readonly driver: CacheDriver;
  readonly version: string | number | undefined;
  readonly waitUntil: WaitUntilFn | undefined;
  readonly scope: object;
}

const capabilitiesByQuery = new WeakMap<
  CallableFunction,
  OfficialCacheCapability
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

function snapshotConfig(value: unknown): OfficialCacheCapability {
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
  return Object.freeze({
    driver,
    version,
    waitUntil,
    scope: createOfficialCacheScope(createOfficialCacheNamespace(version)),
  });
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
): OfficialCacheCapability | undefined {
  return isFunction(query) ? capabilitiesByQuery.get(query) : undefined;
}

export function getOfficialCacheChainCapability(
  chain: ResolvedExtensionChain | undefined
): OfficialCacheCapability | undefined {
  return chain === undefined ? undefined : capabilitiesByChain.get(chain);
}

export function registerOfficialCacheChain(
  chain: ResolvedExtensionChain,
  capability: OfficialCacheCapability
): void {
  capabilitiesByChain.set(chain, capability);
}
