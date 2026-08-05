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
  buildCreateManyPlan,
  buildInsertStatement,
  type CreateManyPlan,
} from "./create";
export {
  buildDelete,
  buildDeleteMany,
  buildDeleteManyAndReturn,
} from "./delete";
export {
  buildFind,
  type FindArgs,
  type FindFirstArgs,
  type FindManyArgs,
  type FindOptions,
} from "./find-common";
export { buildFindUnique } from "./find-unique";
export { buildGroupBy, type GroupByArgs } from "./groupby";
export { buildMutationProjectionFold } from "./mutation-projection-fold";
export {
  buildUpdate,
  buildUpdateMany,
  buildUpdateManyAndReturn,
  buildUpdateStatement,
} from "./update";
export { buildUpsert } from "./upsert";
