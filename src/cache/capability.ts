// The part of the official cache the core client reads on every operation:
// whether a chain carries the cache, and a handle on the cache runtime. The
// runtime itself (cache driver, cache flow, result codecs) is installed by
// `cache()` from `viborm/cache`, so an application that never creates the
// extension does not load it. A chain can only carry the capability after
// `cache()` ran, which is what makes `officialCacheRuntime()` total wherever
// the core asks for it.

import type { ResolvedExtensionChain } from "@extensions/chain";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type {
  GenericQueryHandler,
  OfficialGenericQueryHandler,
} from "@extensions/query";
import { isFunction } from "@validation/value-guards";
import type { CacheDriver, WaitUntilFn } from "./driver";
import type { OfficialCacheRuntime } from "./runtime";
import type { CacheInvalidationOptions } from "./schema";

export const OFFICIAL_CACHE_NAME = "viborm.cache";

/** The exact official query contribution. It is recognized by identity. */
export type OfficialCacheQueryContribution = OfficialGenericQueryHandler & {
  bind(thisArg: unknown): GenericQueryHandler;
};

/**
 * A mutation's `cache` argument is the cache's declared control (ruling 7):
 * core removes and admits it before request handlers run, through the cache's
 * own parser, so a malformed value is still a `CacheConfigurationError`.
 */
export type OfficialCacheControls = {
  readonly cache: {
    readonly schema: StandardSchemaV1<CacheInvalidationOptions>;
    readonly on: "writes";
  };
};

/** The official value accepted by the dedicated `$extends` overload. */
export type OfficialCacheExtension = {
  readonly name: typeof OFFICIAL_CACHE_NAME;
  readonly query: OfficialCacheQueryContribution;
  readonly controls: OfficialCacheControls;
};

/**
 * The cache's one declaration. The chain places it for any definition carrying
 * the cache's query, whatever `controls` that definition spells: the query is
 * the cache's identity, so its control cannot be forged or left out. It lives
 * here, in the part core always loads, and admits through the runtime: a chain
 * carries the cache only after `cache()` installed that runtime.
 */
export const officialCacheControls: OfficialCacheControls = Object.freeze({
  cache: Object.freeze({
    schema: Object.freeze({
      "~standard": Object.freeze({
        version: 1,
        vendor: "viborm",
        validate: (value: unknown) =>
          Object.freeze({
            value: officialCacheRuntime().admitMutationCacheOptions(value),
          }),
      }),
    }),
    on: "writes",
  }),
});

/**
 * What `cache()` knows before it meets a client: no scope, because the scope
 * partitions on facts (dialect, SQL namespace) that only a concrete driver
 * carries. One definition may be appended to several clients.
 */
export interface OfficialCacheDefinitionCapability {
  readonly driver: CacheDriver;
  readonly version: string | number | undefined;
  readonly waitUntil: WaitUntilFn | undefined;
}

/** The definition once bound to one client's driver, gaining its scope. */
export interface OfficialCacheCapability
  extends OfficialCacheDefinitionCapability {
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
let runtime: OfficialCacheRuntime | undefined;

/** Recognize `query` as the official cache's contribution. `cache()` only. */
export function registerOfficialCacheQuery(
  query: CallableFunction,
  capability: OfficialCacheDefinitionCapability,
  installed: OfficialCacheRuntime
): void {
  runtime = installed;
  capabilitiesByQuery.set(query, capability);
}

/** Make the cache runtime reachable; `viborm/cache` does this as it loads. */
export function installOfficialCacheRuntime(
  installed: OfficialCacheRuntime
): void {
  runtime = installed;
}

/** The cache runtime; reachable only where a chain carries the cache. */
export function officialCacheRuntime(): OfficialCacheRuntime {
  if (runtime === undefined)
    throw new Error(
      "The official cache runtime is not loaded: import cache() from viborm/cache."
    );
  return runtime;
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

/** Publish the capability the runtime bound for one chain. */
export function setOfficialCacheChainCapability(
  chain: ResolvedExtensionChain,
  capability: OfficialCacheCapability
): void {
  capabilitiesByChain.set(chain, capability);
}

/**
 * Bind one resolved chain's cache definition to the concrete client driver,
 * deriving the scope that partitions its storage.
 *
 * Called by the client composition root — the one place that holds both the
 * resolved chain and the driver — and only for a chain that carries the
 * official cache, so an ordinary extension costs nothing here.
 */
export function bindOfficialCacheChain(
  chain: ResolvedExtensionChain,
  target: OfficialCacheBindTarget
): void {
  if (definitionsByChain.get(chain) === undefined) return;
  officialCacheRuntime().bindChain(chain, target);
}

/** Whether an operation runs under the official cache's managed execution. */
export function isCacheManagedExecution(
  options: { readonly skipSpan?: boolean } | undefined
): boolean {
  return options?.skipSpan === true;
}
