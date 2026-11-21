/**
 * What the engine asks of the SurrealDB driver, in a module of its own: the
 * migrations write a view's body with the engine view a client of this driver
 * reads it with, and import this without the driver.
 */

import { passThroughParseResult } from "@adapters/adapter-result-parser";
import type { EngineFacts } from "@adapters/database-adapter";

/** What the engine asks of any driver. */
export const SURREAL_FACTS: EngineFacts = {
  namespace: undefined,
  // A point's statements are this driver's own: the fact is that it holds them.
  geoPoint: {},
  // A strategy `Commands` asks about, not syntax: `INSERT IGNORE` skips.
  mutations: { skipDuplicatesStrategy: "sql" },
  // A widened sum asks whether it travels in parts here, and it never does.
  aggregates: {},
  result: {
    nativeScalarPassthrough: true,
    parseResult: passThroughParseResult,
    parseRelation: (_value, next) => next(),
    parseField: (_value, _type, next) => next(),
  },
  capabilities: {
    supportsReturning: true,
    supportsCteWithMutations: false,
    supportsFullOuterJoin: false,
    supportsLateralJoins: false,
    supportsVector: true,
    supportsUpsertWhere: false,
    supportsTargetedUpsert: true,
    supportsMutationTargetInSubquery: false,
    supportsMutationRowLimit: false,
    supportsRowLocks: false,
  },
};
