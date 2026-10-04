import { CacheConfigurationError } from "@errors";
import type { GenericQueryHandler } from "@extensions/query";
import {
  isFunction,
  isNumber,
  isRecord,
  isString,
} from "@validation/value-guards";
import { isError } from "../errors/diagnostic-safety";
import {
  OFFICIAL_CACHE_NAME,
  type OfficialCacheDefinitionCapability,
  type OfficialCacheExtension,
  officialCacheControls,
  registerOfficialCacheQuery,
} from "./capability";
import { CacheDriver, type WaitUntilFn } from "./driver";
import { OFFICIAL_CACHE_RUNTIME } from "./runtime";

// The capability helpers moved to `./capability` so the core client can read
// them without loading the cache; they stay importable from here.
export {
  bindOfficialCacheChain,
  getOfficialCacheChainCapability,
  getOfficialCacheChainDefinition,
  getOfficialCacheQueryCapability,
  OFFICIAL_CACHE_NAME,
  type OfficialCacheBindTarget,
  type OfficialCacheControls,
  type OfficialCacheExtension,
  type OfficialCacheQueryContribution,
  registerOfficialCacheChain,
} from "./capability";
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
  registerOfficialCacheQuery(query, capability, OFFICIAL_CACHE_RUNTIME);
  return Object.freeze({
    name: OFFICIAL_CACHE_NAME,
    query,
    controls: officialCacheControls,
  });
}
