// Args schema factories - re-exports

import type { AnyModel } from "@schema/model";
import { lazyRecord } from "../../lazy";
import type { CoreSchemas } from "../core";
import type { ScalarSchemas } from "../index";
import {
  type AggregateArgs,
  type CountArgs,
  type GroupByArgs,
  getAggregateArgs,
  getCountArgs,
  getGroupByArgs,
} from "./aggregate";
import {
  type FindFirstArgs,
  type FindManyArgs,
  type FindUniqueArgs,
  getFindFirstArgs,
  getFindManyArgs,
  getFindUniqueArgs,
} from "./find";
import type {
  CreateArgs,
  CreateManyAndReturnArgs,
  CreateManyArgs,
  DeleteArgs,
  DeleteManyArgs,
  UpdateArgs,
  UpdateManyAndReturnArgs,
  UpdateManyArgs,
  UpsertArgs,
} from "./mutation";
import {
  getCreateArgs,
  getCreateManyAndReturnArgs,
  getCreateManyArgs,
  getDeleteArgs,
  getDeleteManyArgs,
  getUpdateArgs,
  getUpdateManyAndReturnArgs,
  getUpdateManyArgs,
  getUpsertArgs,
} from "./mutation";

// Aggregate exports
export {
  getAggregateArgs,
  getAggregateScalarSchemas,
  getCountArgs,
  getGroupByArgs,
} from "./aggregate";
// Find exports
export { getFindFirstArgs, getFindManyArgs, getFindUniqueArgs } from "./find";
// Mutation exports
export {
  getCreateArgs,
  getCreateManyAndReturnArgs,
  getCreateManyArgs,
  getDeleteArgs,
  getDeleteManyArgs,
  getUpdateArgs,
  getUpdateManyAndReturnArgs,
  getUpdateManyArgs,
  getUpsertArgs,
} from "./mutation";

export type ArgsSchemas<M extends AnyModel, F extends ScalarSchemas<M>> = {
  findUnique: FindUniqueArgs<M, F>;
  findFirst: FindFirstArgs<M, F>;
  findMany: FindManyArgs<M, F>;
  create: CreateArgs<M, F>;
  createMany: CreateManyArgs<M, F>;
  createManyAndReturn: CreateManyAndReturnArgs<M, F>;
  update: UpdateArgs<M, F>;
  updateMany: UpdateManyArgs<M, F>;
  updateManyAndReturn: UpdateManyAndReturnArgs<M, F>;
  delete: DeleteArgs<M, F>;
  deleteMany: DeleteManyArgs<M, F>;
  upsert: UpsertArgs<M, F>;
  count: CountArgs<M, F>;
  aggregate: AggregateArgs<M, F>;
  groupBy: GroupByArgs<M, F>;
};

export const getArgsSchemas = <M extends AnyModel, F extends ScalarSchemas<M>>(
  model: M,
  _fieldSchemas: F,
  core: CoreSchemas<M, F>
): ArgsSchemas<M, F> => {
  // Each operation's arg schema is built on first access and memoized. The
  // validator only reads a single `args[operation]` per query, so unused
  // operations are never constructed — and because each builder pulls from the
  // lazy `core` object, only the core schemas that operation needs get built.
  return lazyRecord<ArgsSchemas<M, F>>({
    findUnique: () => getFindUniqueArgs(core),
    findFirst: () => getFindFirstArgs(model, core),
    findMany: () => getFindManyArgs(model, core),
    create: () => getCreateArgs(core),
    createMany: () => getCreateManyArgs(core),
    createManyAndReturn: () => getCreateManyAndReturnArgs(core),
    update: () => getUpdateArgs(core),
    updateMany: () => getUpdateManyArgs(core),
    updateManyAndReturn: () => getUpdateManyAndReturnArgs(core),
    delete: () => getDeleteArgs(core),
    deleteMany: () => getDeleteManyArgs(core),
    upsert: () => getUpsertArgs(core),
    count: () => getCountArgs(model, core),
    aggregate: () => getAggregateArgs(model, core),
    groupBy: () => getGroupByArgs(model, _fieldSchemas, core),
  });
};
