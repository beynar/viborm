// Relation exports
// Re-exports all public types and factory functions

// =============================================================================
// CARDINALITY
// =============================================================================
export {
  type PolymorphicCardinalityOf,
  polymorphicCardinality,
  type RelationCardinality,
  relationCardinality,
} from "./cardinality";
// =============================================================================
// CLEARABILITY
// =============================================================================
export {
  type MembershipCanBeCleared,
  membershipCanBeCleared,
  type SlotMayBeEmpty,
  slotMayBeEmpty,
} from "./clearability";
// =============================================================================
// HELPERS
// =============================================================================
export {
  generateJunctionFieldName,
  generateJunctionTableName,
  getJunctionFieldNames,
  getJunctionTableName,
} from "./helpers";
export {
  type CanBindPolymorphicInverse,
  type CompatiblePolymorphicBinding,
  canBindPolymorphicInverse,
  collectInverseCandidates,
  getCompatiblePolymorphicInverseBinding,
  getPolymorphicInverseBinding,
  type ResolvedInverseCandidate,
  type ResolvedInverseRelation,
  resolveInverseRelation,
  resolveOrdinaryInverse,
} from "./inverse";
export { ManyToManyRelation, manyToMany } from "./many-to-many";
export {
  type AnyPolymorphicRelation,
  type GetPolymorphicInverseBinding,
  getPolymorphicInverseCandidates,
  isPolymorphicRelation,
  type PolymorphicCardinality,
  type PolymorphicInverseBinding,
  type PolymorphicInverseCardinality,
  type PolymorphicJunctionMember,
  type PolymorphicRelationState,
  type PolymorphicStateOf,
  type PolymorphicStorage,
  type PolymorphicStorageColumn,
  type PolymorphicStorageMember,
  type PolymorphicTargetGetters,
  type PolymorphicThroughEntry,
  PolymorphicToManyRelation,
  type PolymorphicToManyState,
  type PolymorphicToManyStorage,
  PolymorphicToOneRelation,
  type PolymorphicToOneState,
  type PolymorphicToOneStorage,
  polymorphicToMany,
  polymorphicToOne,
} from "./polymorphic";
export { oneToMany, ToManyRelation } from "./to-many";
// =============================================================================
// RELATION CLASSES
// =============================================================================
export { manyToOne, oneToOne, ToOneRelation } from "./to-one";
// =============================================================================
// BASE TYPES
// =============================================================================
export type {
  Getter,
  ManyToManyRelationState,
  ReferentialAction,
  RelationState,
  RelationType,
  ToManyRelationState,
  ToOneRelationState,
} from "./types";

// =============================================================================
// ANY RELATION (union of all concrete relation types)
// =============================================================================
import type { ManyToManyRelation } from "./many-to-many";
import type { ToManyRelation } from "./to-many";
import type { ToOneRelation } from "./to-one";
import type {
  ManyToManyRelationState,
  ToManyRelationState,
  ToOneRelationState,
} from "./types";

/** Union type of all relation classes */
export type AnyRelation =
  | ToOneRelation<ToOneRelationState>
  | ToManyRelation<ToManyRelationState>
  | ManyToManyRelation<ManyToManyRelationState>;
