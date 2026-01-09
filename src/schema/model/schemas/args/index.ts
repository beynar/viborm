// Args schema factories - re-exports

import type { ModelState } from "@schema/model";
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

export type ModelArgs<T extends ModelState> = {
  findUnique: FindUniqueArgs<T>;
  findFirst: FindFirstArgs<T>;
  findMany: FindManyArgs<T>;
  create: CreateArgs<T>;
  createMany: CreateManyArgs<T>;
  update: UpdateArgs<T>;
  updateMany: UpdateManyArgs<T>;
  delete: DeleteArgs<T>;
  deleteMany: DeleteManyArgs<T>;
  upsert: UpsertArgs<T>;
  count: CountArgs<T>;
  aggregate: AggregateArgs<T>;
  groupBy: GroupByArgs<T>;
};
