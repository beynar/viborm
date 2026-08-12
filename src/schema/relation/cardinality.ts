// The ONE reading of a relation's cardinality.
//
// `RelationType` names four edges and every consumer that cares about MANY vs ONE
// re-derived the same disjunction from it: the query scope's `RelationInfo`, the
// result parser's array-vs-object decision, the validation layer's to-many/to-one
// schema choice, and the order-by builder's to-one restriction. Four spellings of
// one fact, and each was free to drift — a fifth relation type would have had to be
// remembered in four places.
//
// It is NOT folded into `RelationResultKind` (`adapters/adapter-result-parser.ts`).
// That type is the PUBLISHED adapter hook argument: three built-in adapters and the
// driver instrumentation declare it, so widening it to carry cardinality would make
// every adapter author restate a fact the schema already owns. The parser consumes
// this function BESIDE the published kind instead.
//
// No type twin (unlike `clearability.ts`, which has two): nothing branches on
// cardinality at the TYPE level — `getRelationSchemas` casts its result — so a twin
// would be a second declaration with no reader.

import type { RelationState } from "./types";

/** MANY rows on the far side, or at most one. */
export type RelationCardinality = "one" | "many";

/**
 * Does this relation address many rows, or one?
 *
 * `oneToMany` and `manyToMany` are the two that do; the name of each edge already
 * says so, which is why this is a total function over `RelationType` with no
 * fallback.
 */
export const relationCardinality = (
  state: RelationState
): RelationCardinality =>
  state.type === "oneToMany" || state.type === "manyToMany" ? "many" : "one";
