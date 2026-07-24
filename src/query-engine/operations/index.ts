/**
 * Operations Module
 *
 * Exports all query operation builders.
 */

export { type AggregateArgs, buildAggregate } from "./aggregate";
// Aggregate operations
export { buildCount } from "./count";
// Mutation operations
export {
  buildCreate,
  buildCreateMany,
  buildCreateManyAndReturn,
  buildCreateManyPlan,
  type CreateManyPlan,
} from "./create";
export { buildDelete, buildDeleteMany } from "./delete";
export {
  buildFind,
  type FindArgs,
  type FindFirstArgs,
  type FindManyArgs,
  type FindOptions,
} from "./find-common";
export { buildFindUnique } from "./find-unique";
export { buildGroupBy, type GroupByArgs } from "./groupby";
export {
  buildUpdate,
  buildUpdateMany,
  buildUpdateManyAndReturn,
} from "./update";
export { buildUpsert } from "./upsert";
