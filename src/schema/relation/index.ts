// Relation exports
// Re-exports all public types and factory functions

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
  canBindPolymorphicInverse,
  collectInverseCandidates,
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
  type PolymorphicInverseBinding,
  type PolymorphicInverseCardinality,
  PolymorphicRelation,
  type PolymorphicRelationState,
  type PolymorphicStorage,
  type PolymorphicStorageColumn,
  type PolymorphicStorageMember,
  type PolymorphicTargetGetters,
  polymorphic,
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
