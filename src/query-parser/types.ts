import { Model, Field, Relation } from "@schema";
import { Operations, QueryMode } from "@types";

/**
 * Shared Types for Query Parser Components
 *
 * This file contains all the shared types and interfaces used across the
 * query parser component system. It serves as the central type definition
 * hub to ensure consistency and avoid circular dependencies.
 *
 * TYPE CATEGORIES:
 * - BuilderContext: Core context passed between components
 * - Component Interfaces: Contracts for all component types
 * - Specialized Contexts: Extended contexts for specific operations
 * - Utility Types: Helper types for type safety and inference
 *
 * DESIGN PRINCIPLES:
 * - Extensible: Easy to add new fields without breaking existing code
 * - Type-safe: Leverages TypeScript's type system for compile-time safety
 * - Minimal: Only includes necessary information to avoid bloat
 * - Consistent: Follows established patterns from the existing codebase
 */

/**
 * Core BuilderContext - Extended from Original
 *
 * This is the enhanced version of the original BuilderContext that includes
 * all the missing fields needed for complete feature support. It's passed
 * between all components to provide necessary context for SQL generation.
 */
export type BuilderContext = {
  // Core identification
  model: Model<any>;
  field?: Field;
  relation?: Relation<any, any>;
  baseOperation: Operations;
  alias: string;

  // Relation context
  parentAlias?: string;
  fieldName?: string;

  // Pagination context (restored from original)
  take?: number;
  skip?: number;
  cursor?: any;
  distinct?: string[];

  // Mutation context
  data?: any;
  conflictFields?: string[];

  // Query context
  mode?: QueryMode;
  orderBy?: any;

  // Advanced context
  isNested?: boolean;
  depth?: number;
  path?: string[];
};

/**
 * Specialized Contexts for Different Operations
 */
export interface PaginationContext {
  take?: number;
  skip?: number;
  cursor?: any;
  orderBy?: any;
  hasStableOrdering?: boolean;
}

export interface MutationContext {
  data: any;
  conflictFields?: string[];
  cascadeDeletes?: boolean;
  optimisticLocking?: boolean;
}

export interface RelationContext {
  relation: Relation<any, any>;
  parentAlias: string;
  childAlias: string;
  relationType: "oneToOne" | "manyToOne" | "oneToMany" | "manyToMany";
  linkCondition?: any;
}

export interface AggregationContext {
  aggregations: Record<string, any>;
  groupBy?: string[];
  having?: any;
}

/**
 * Component Interface Contracts
 *
 * These interfaces define the contracts that all components must implement.
 * They ensure consistency across the component system and enable proper
 * dependency injection and testing.
 */

export interface QueryParserComponent {
  readonly name: string;
  readonly dependencies: string[];
}

export interface ClauseBuilder extends QueryParserComponent {
  build(context: BuilderContext, ...args: any[]): any;
}

export interface OperationHandler extends QueryParserComponent {
  canHandle(operation: Operations): boolean;
  handle(model: Model<any>, payload: any): any;
}

export interface FieldHandler extends QueryParserComponent {
  canHandle(fieldType: string): boolean;
  handle(context: BuilderContext, ...args: any[]): any;
}

export interface RelationHandler extends QueryParserComponent {
  canHandle(relationType: string): boolean;
  handle(context: RelationContext, ...args: any[]): any;
}

/**
 * Utility Types for Type Safety
 */

export type FilterHandler<T = any> = (ctx: BuilderContext, value: T) => any;

export type UpdateHandler<T = any> = (ctx: BuilderContext, value: T) => any;

export type ValidationResult = {
  valid: boolean;
  errors?: string[];
  warnings?: string[];
};

export type QueryClauses = {
  select?: any;
  from?: any;
  where?: any;
  orderBy?: any;
  limit?: any;
  groupBy?: any;
  having?: any;
  include?: any[];
};

export type MutationClauses = {
  insert?: any;
  update?: any;
  delete?: any;
  values?: any;
  set?: any;
  where?: any;
  returning?: any;
};

export type UpsertClauses = {
  insert?: any;
  update?: any;
  conflict?: any;
  where?: any;
  returning?: any;
};

/**
 * Configuration Types
 */

export interface QueryParserConfig {
  maxDepth?: number;
  enableOptimizations?: boolean;
  strictValidation?: boolean;
  debugMode?: boolean;
}

export interface ComponentConfig {
  enabled?: boolean;
  options?: Record<string, any>;
}

/**
 * Error Types
 */

/**
 * Performance Monitoring Types
 */

export interface PerformanceMetrics {
  parseTime: number;
  componentTimes: Record<string, number>;
  sqlLength: number;
  complexity: number;
}

/**
 * Extension Types for Future Features
 */

export interface ExtensionPoint {
  name: string;
  phase: "before" | "after" | "replace";
  handler: (context: any, ...args: any[]) => any;
}

export interface Plugin {
  name: string;
  version: string;
  extensions: ExtensionPoint[];
  dependencies?: string[];
}
