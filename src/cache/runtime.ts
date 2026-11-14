// What the core client calls only once a chain carries the official cache:
// the scope binding, the cache flow and the cached result codec. `cache()`
// installs this object, so it loads with `viborm/cache` and never with the
// core client alone.

import type { ResolvedExtensionChain } from "@extensions/chain";
import {
  admitMutationCacheOptions,
  cacheKeyOf,
  createCacheExecutionOptions,
  executeCachedResultOperation,
  invalidateManualCache,
  prepareMutationCacheWriteOutcome,
  readMutationCacheOptions,
  validateCacheableOperation,
} from "@query-engine/cache-flow";
import {
  getOfficialCacheChainDefinition,
  installOfficialCacheRuntime,
  type OfficialCacheBindTarget,
  setOfficialCacheChainCapability,
} from "./capability";
import { createOfficialCacheScope, readCacheExecutionOutcomes } from "./driver";
import { createOfficialCacheNamespace } from "./key";
import { routedCodec } from "./result-codec";

/**
 * The derivation is pure, so appending another extension re-derives the SAME
 * namespace: the scope is retained by value, with no registry keyed on chain
 * identity to keep in step and no second scope to split the cache.
 */
function bindChain(
  chain: ResolvedExtensionChain,
  target: OfficialCacheBindTarget
): void {
  const definition = getOfficialCacheChainDefinition(chain);
  if (definition === undefined) return;
  setOfficialCacheChainCapability(
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

export const OFFICIAL_CACHE_RUNTIME = Object.freeze({
  admitMutationCacheOptions,
  bindChain,
  cacheKeyOf,
  createCacheExecutionOptions,
  executeCachedResultOperation,
  invalidateManualCache,
  prepareMutationCacheWriteOutcome,
  readCacheExecutionOutcomes,
  readMutationCacheOptions,
  routedCodec,
  validateCacheableOperation,
});

export type OfficialCacheRuntime = typeof OFFICIAL_CACHE_RUNTIME;

// Loading the cache entry is what makes the runtime reachable. `cache()`
// installs it too, so a bundler that drops this statement changes nothing.
installOfficialCacheRuntime(OFFICIAL_CACHE_RUNTIME);
