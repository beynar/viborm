// Args schema factories - re-exports

import type { AnyModel, ModelState } from "@schema/model";
import type { AggregateArgs, CountArgs, GroupByArgs } from "./aggregate";
import type { FindFirstArgs, FindManyArgs, FindUniqueArgs } from "./find";
import type {
  CreateArgs,
  CreateManyArgs,
  DeleteArgs,
  DeleteManyArgs,
  UpdateArgs,
  UpdateManyArgs,
  UpsertArgs,
} from "./mutation";
import { FieldSchemas } from "@validation/builder";

// Aggregate exports
export {
  getAggregateArgs,
  getAggregateFieldSchemas,
  getCountArgs,
  getGroupByArgs,
} from "./aggregate";
// Find exports
export { getFindFirstArgs, getFindManyArgs, getFindUniqueArgs } from "./find";
// Mutation exports
export {
  getCreateArgs,
  getCreateManyArgs,
  getDeleteArgs,
  getDeleteManyArgs,
  getUpdateArgs,
  getUpdateManyArgs,
  getUpsertArgs,
} from "./mutation";

export type ArgsSchemas<M extends AnyModel, F extends FieldSchemas<M>> = {
  findUnique: FindUniqueArgs<M, F>;
  findFirst: FindFirstArgs<M, F>;
  findMany: FindManyArgs<M, F>;
  create: CreateArgs<M, F>;
  createMany: CreateManyArgs<M, F>;
  update: UpdateArgs<M, F>;
  updateMany: UpdateManyArgs<M, F>;
  delete: DeleteArgs<M, F>;
  deleteMany: DeleteManyArgs<M, F>;
  upsert: UpsertArgs<M, F>;
  count: CountArgs<M, F>;
  aggregate: AggregateArgs<M, F>;
  groupBy: GroupByArgs<M, F>;
};
