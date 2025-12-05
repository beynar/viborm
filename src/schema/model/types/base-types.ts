// Base Utility Types
// Common types used across the model type system

// =============================================================================
// TYPE PERFORMANCE UTILITIES
// =============================================================================

/**
 * Simplify - flattens intersection types into a single object type
 * This forces TypeScript to compute and cache the result once instead of
 * re-evaluating intersections on every access
 */
export type Simplify<T> = { [K in keyof T]: T[K] } & {};

// =============================================================================
// UTILITY TYPES
// =============================================================================

/**
 * AtLeast utility - requires at least one of the specified keys to be present
 * Similar to Prisma's AtLeast utility
 */
export type AtLeast<T, K extends keyof T> = Partial<T> &
  { [P in K]: Required<Pick<T, P>> }[K];

// =============================================================================
// SORT ORDER TYPES
// =============================================================================

/**
 * Sort order for orderBy clauses
 */
export type SortOrder = "asc" | "desc";

/**
 * Nulls order for orderBy clauses
 */
export type NullsOrder = "first" | "last";

/**
 * Extended sort order input with nulls handling
 */
export type SortOrderInput =
  | SortOrder
  | { sort: SortOrder; nulls?: NullsOrder };

