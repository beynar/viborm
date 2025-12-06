// Unchecked Create/Update Types
// Exposes foreign keys directly instead of nested relation operations
// Use these when you have the FK value and don't need nested mutations

import type { Relation } from "../../relation/relation";
import type {
  FieldRecord,
  ScalarFieldKeys,
  InferFieldCreate,
  InferFieldUpdate,
} from "./helpers";

// =============================================================================
// HELPER TYPES (local, specific to unchecked types)
// =============================================================================

/**
 * Extracts to-one relation keys (manyToOne, oneToOne)
 * These are the relations that have a foreign key on this model
 */
type ToOneRelationKeys<T extends FieldRecord> = {
  [K in keyof T]: T[K] extends Relation<any, infer Type, any>
    ? Type extends "manyToOne" | "oneToOne"
      ? K
      : never
    : never;
}[keyof T];

// =============================================================================
// FOREIGN KEY TYPES
// =============================================================================

/**
 * Foreign key fields derived from to-one relations
 * Convention: relationName + "Id" (e.g., author → authorId)
 *
 * Note: In a real implementation, this would read from relation config
 * For now, we use the convention-based approach
 */
export type ForeignKeyFields<T extends FieldRecord> = {
  [K in ToOneRelationKeys<T> as `${K & string}Id`]?: string;
};

/**
 * Optional foreign key fields (for update operations)
 */
export type ForeignKeyFieldsOptional<T extends FieldRecord> = {
  [K in ToOneRelationKeys<T> as `${K & string}Id`]?: string | null;
};

// =============================================================================
// UNCHECKED CREATE INPUT
// =============================================================================

/**
 * Unchecked create input - uses FK fields instead of nested relation operations
 *
 * Example:
 * // Regular create:
 * { author: { connect: { id: "123" } } }
 *
 * // Unchecked create:
 * { authorId: "123" }
 */
export type ModelUncheckedCreateInput<T extends FieldRecord> =
  // All scalar fields with their create types
  {
    [K in ScalarFieldKeys<T>]: InferFieldCreate<T[K]>;
  } & // Foreign key fields (optional - can use connect or FK)
  ForeignKeyFields<T>;

// =============================================================================
// UNCHECKED UPDATE INPUT
// =============================================================================

/**
 * Unchecked update input - uses FK fields instead of nested relation operations
 *
 * Example:
 * // Regular update:
 * { author: { connect: { id: "456" } } }
 *
 * // Unchecked update:
 * { authorId: "456" }
 *
 * // Disconnect (set to null):
 * { authorId: null }
 */
export type ModelUncheckedUpdateInput<T extends FieldRecord> =
  // All scalar fields optional with update types
  {
    [K in ScalarFieldKeys<T>]?: InferFieldUpdate<T[K]>;
  } & // Foreign key fields (optional, nullable for disconnect)
  ForeignKeyFieldsOptional<T>;

// =============================================================================
// UNCHECKED CREATE MANY INPUT
// =============================================================================

/**
 * Unchecked create many input - for bulk inserts with FK fields
 * Same as UncheckedCreateInput but without nested relations
 */
export type ModelUncheckedCreateManyInput<T extends FieldRecord> = {
  [K in ScalarFieldKeys<T>]: InferFieldCreate<T[K]>;
} & ForeignKeyFields<T>;

// =============================================================================
// UNCHECKED UPDATE MANY INPUT
// =============================================================================

/**
 * Unchecked update many input - for bulk updates with FK fields
 */
export type ModelUncheckedUpdateManyInput<T extends FieldRecord> = {
  [K in ScalarFieldKeys<T>]?: InferFieldUpdate<T[K]>;
} & ForeignKeyFieldsOptional<T>;

// =============================================================================
// TYPE GUARDS / UTILITIES
// =============================================================================

/**
 * Checks if a field name is a foreign key field
 */
export const isForeignKeyField = (fieldName: string): boolean => {
  return fieldName.endsWith("Id");
};

/**
 * Gets the relation name from a foreign key field
 */
export const getRelationFromFk = (fkFieldName: string): string | null => {
  if (!fkFieldName.endsWith("Id")) return null;
  return fkFieldName.slice(0, -2);
};

/**
 * Gets the foreign key field name from a relation name
 */
export const getFkFromRelation = (relationName: string): string => {
  return `${relationName}Id`;
};


