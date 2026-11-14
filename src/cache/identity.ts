/**
 * The official cache as a chain meets it: recognized by its `query`, applied
 * once and under its own name, its control the cache's own, and carried by
 * every later chain. Brought by `cache()` and by what applies definitions
 * written as object literals.
 */
import type { ExtensionPart } from "@extensions/chain";
import { controlsPart } from "@extensions/controls";
import { ARRAYS, coordinate } from "@extensions/coordination";
import {
  assertOfficialExtensionAdmission,
  withoutIdentity,
} from "@extensions/identity";
import { queryPart } from "@extensions/query";
import {
  getOfficialCacheChainDefinition,
  getOfficialCacheQueryCapability,
  OFFICIAL_CACHE_NAME,
  officialCacheControls,
  registerOfficialCacheChain,
} from "./capability";

export const cacheIdentity: ExtensionPart = {
  // The cache's control is placed, and a chain it is applied to holds a
  // query lookup, as for any definition with `controls` and `query`.
  uses: [controlsPart, queryPart],
  carry: true,
  admit(application) {
    const { definition, chain } = application;
    const incoming = getOfficialCacheQueryCapability(definition.query);
    assertOfficialExtensionAdmission({
      definitionName: definition.name,
      officialName: OFFICIAL_CACHE_NAME,
      label: "cache",
      hasIdentity: incoming !== undefined,
      isAlreadyPresent: getOfficialCacheChainDefinition(chain) !== undefined,
      duplicateMessage:
        "The official cache extension is already present on this client.",
    });
    // The cache's query leaves the chain's handlers; its control is its own.
    if (incoming !== undefined)
      application.definition = Object.freeze({
        ...withoutIdentity(definition, "query"),
        controls: officialCacheControls,
      });
  },
  seal({ next, chain, declared }) {
    const official =
      getOfficialCacheQueryCapability(declared.query) ??
      getOfficialCacheChainDefinition(chain);
    if (official === undefined) return;
    registerOfficialCacheChain(next, official);
    next.hasCache = true;
    coordinate(next, ARRAYS);
  },
};
