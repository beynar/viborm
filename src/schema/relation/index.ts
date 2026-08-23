// Relation exports.
//
// Two factories, one state union, and the derived views their owners publish.
// The four terminal implementations are deliberately absent: callers see only
// the capabilities `toOne` and `toMany` return, and `junction-topology.ts` stays
// unexported here because its consumers deep-import it.

// =============================================================================
// CLEARABILITY
// =============================================================================
export {
  type ClearableMembership,
  clearableMembership,
  membershipCanBeCleared,
  slotMayBeEmpty,
} from "./clearability";
// =============================================================================
// HELPERS
// =============================================================================
export {
  generateJunctionFieldName,
  generateJunctionTableName,
} from "./helpers";
// =============================================================================
// RESOLVED VARIANT STORAGE COLUMN
// =============================================================================
export type { PolymorphicStorageColumn } from "./polymorphic";
// =============================================================================
// FACTORIES
// =============================================================================
export { toMany } from "./to-many";
export { toOne } from "./to-one";
// =============================================================================
// DECLARATION STATE
// =============================================================================
export type {
  AnyRelation,
  ForeignKeyDeclaration,
  Getter,
  JunctionReferentialAction,
  ModelTarget,
  ModelToManyState,
  ModelToOneState,
  NonEmptyFieldTuple,
  OrdinaryJunctionOverrides,
  ReferentialAction,
  RelationCardinality,
  RelationInternal,
  RelationSlot,
  RelationState,
  VariantEntry,
  VariantJunctionOverride,
  VariantManyEntry,
  VariantOneEntry,
  VariantRelationState,
  VariantTarget,
  VariantToManyState,
  VariantToOneState,
} from "./types";
// =============================================================================
// TARGET DOMAIN
// =============================================================================
export { isVariantRelationState } from "./types";
