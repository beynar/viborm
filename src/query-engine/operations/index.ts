/**
 * Operations Module
 *
 * Exports all query operation builders.
 */

export { type AggregateArgs, buildAggregate } from "./aggregate";
// Aggregate operations
export { buildCount } from "./count";
// Mutation operations
export { buildCreate, buildCreateMany } from "./create";
export { buildDelete, buildDeleteMany } from "./delete";
export { buildFind, type FindArgs, type FindOptions } from "./find-common";
export type { FindFirstArgs } from "./find-first";
// Find operations
export { buildFindFirst } from "./find-first";
export type { FindManyArgs } from "./find-many";
export { buildFindMany } from "./find-many";
export { buildFindUnique } from "./find-unique";
export { buildGroupBy, type GroupByArgs } from "./groupby";
export type {
  NestedCreateResult,
  TransactionContext,
  TransactionStep,
} from "./nested-writes";
// Nested write operations
export { executeNestedCreate, executeNestedUpdate } from "./nested-writes";
export { buildUpdate, buildUpdateMany } from "./update";
export { buildUpsert } from "./upsert";
