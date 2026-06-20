// Args schema factories - re-exports

import type { AnyModel } from "@schema/model";
import {
  getAggregateArgs,
  type AggregateArgs,
  getCountArgs,
  type CountArgs,
  getGroupByArgs,
  type GroupByArgs,
} from "./aggregate";
import {
  getFindFirstArgs,
  type FindFirstArgs,
  getFindManyArgs,
  type FindManyArgs,
  getFindUniqueArgs,
  type FindUniqueArgs,
} from "./find";
import type {
  CreateArgs,
  CreateManyArgs,
  DeleteArgs,
  DeleteManyArgs,
  UpdateArgs,
  UpdateManyArgs,
  UpsertArgs,
} from "./mutation";
import {
  getCreateArgs,
  getCreateManyArgs,
  getDeleteArgs,
  getDeleteManyArgs,
  getUpdateArgs,
  getUpdateManyArgs,
  getUpsertArgs,
} from "./mutation";
import type { CoreSchemas } from "../core";
import type { FieldSchemas } from "../index";

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

export const getArgsSchemas = <
  M extends AnyModel,
  F extends FieldSchemas<M>,
>(
  model: M,
  _fieldSchemas: F,
  core: CoreSchemas<M, F>,
): ArgsSchemas<M, F> => {
  return {
    findUnique: getFindUniqueArgs(core),
    findFirst: getFindFirstArgs(core),
    findMany: getFindManyArgs(model, core),
    create: getCreateArgs(core),
    createMany: getCreateManyArgs(core),
    update: getUpdateArgs(core),
    updateMany: getUpdateManyArgs(core),
    delete: getDeleteArgs(core),
    deleteMany: getDeleteManyArgs(core),
    upsert: getUpsertArgs(core),
    count: getCountArgs(model, core),
    aggregate: getAggregateArgs(model, core),
    groupBy: getGroupByArgs(model, _fieldSchemas, core),
  };
};
