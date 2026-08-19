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
// The ORDINARY reader has no type twin: nothing branches on an ordinary relation's
// cardinality at the TYPE level — `getRelationSchemas` casts its result
// (`validation/relations/index.ts:170`) — so a twin would be a second declaration
// with no reader. The POLYMORPHIC reader has one from the day it lands, because
// create requiredness branches on it at both levels
// (`validation/model/core/create.ts`), and Package C adds the result wrapper.

import type { PolymorphicRelationState } from "./polymorphic";
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

/**
 * Does this polymorphic SLOT hold one membership, or a collection?
 *
 * Unlike an ordinary relation, a carrier does not encode this in its `type`: the
 * factory the declaration is spelled with (`s.polymorphicToOne` /
 * `s.polymorphicToMany`) is the whole fact,
 * so this is a plain read. Consumers must branch through it rather than testing
 * `state.cardinality` inline.
 */
export const polymorphicCardinality = (
  state: PolymorphicRelationState
): RelationCardinality => state.cardinality;

/** The type twin of {@link polymorphicCardinality} — one rule, both levels. */
export type PolymorphicCardinalityOf<S extends PolymorphicRelationState> =
  S["cardinality"];
