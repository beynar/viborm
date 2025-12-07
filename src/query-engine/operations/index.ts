/**
 * Operations Module
 *
 * Exports all query operation builders.
 */

// Find operations
export { buildFindFirst } from "./find-first";
export type { FindFirstArgs } from "./find-first";
export { buildFindMany } from "./find-many";
export type { FindManyArgs } from "./find-many";
export { buildFindUnique } from "./find-unique";
export { buildFind, type FindArgs, type FindOptions } from "./find-common";

// Mutation operations
export { buildCreate, buildCreateMany } from "./create";
export { buildUpdate, buildUpdateMany } from "./update";
export { buildDelete, buildDeleteMany } from "./delete";
export { buildUpsert } from "./upsert";

// Aggregate operations
export { buildCount } from "./count";
export { buildAggregate, type AggregateArgs } from "./aggregate";
export { buildGroupBy, type GroupByArgs } from "./groupby";

// Nested write operations
export { executeNestedCreate, executeNestedUpdate } from "./nested-writes";
export type { NestedCreateResult, TransactionStep, TransactionContext } from "./nested-writes";

