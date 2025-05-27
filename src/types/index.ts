// Type Definitions Index
// All TypeScript types and interfaces for BaseORM

// Re-export all types from their respective modules
export * from "./scalars.js";
export * from "./validators.js";
export * from "./models.js";
export * from "./relations.js";
export * from "./utilities.js";
export * from "./field-states.js";
export * from "./standardSchema.js";

// Export specific types to avoid conflicts
export type { BatchPayload, WhereInputBase } from "./operations.js";

export type {
  FindUniqueArgs,
  FindFirstArgs,
  FindManyArgs,
  CreateArgs,
  CreateManyArgs,
  UpdateArgs,
  UpdateManyArgs,
  UpsertArgs,
  DeleteArgs,
  DeleteManyArgs,
  CountArgs,
  AggregateArgs,
  GroupByArgs,
  DatabaseClient,
} from "./queries.js";

export type {
  StringFilter,
  NumberFilter,
  BoolFilter,
  DateTimeFilter,
  FieldFilter,
} from "./filters.js";
