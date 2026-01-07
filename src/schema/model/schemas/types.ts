// Shared types for model schemas

import type { VibSchema } from "@validation";
import type { ModelState } from "../model";
import type {
  getAggregateArgs,
  getCountArgs,
  getCreateArgs,
  getCreateManyArgs,
  getDeleteArgs,
  getDeleteManyArgs,
  getFindFirstArgs,
  getFindManyArgs,
  getFindUniqueArgs,
  getGroupByArgs,
  getUpdateArgs,
  getUpdateManyArgs,
  getUpsertArgs,
} from "./args";
import type {
  CreateSchema,
  getCompoundConstraintFilter,
  getCompoundIdFilter,
  IncludeSchema,
  OrderBySchema,
  RelationCreateSchema,
  RelationFilterSchema,
  RelationUpdateSchema,
  ScalarCreateSchema,
  ScalarFilterSchema,
  ScalarUpdateSchema,
  SelectSchema,
  UniqueFilterSchema,
  UpdateSchema,
  WhereSchema,
  WhereUniqueSchema,
} from "./core";

/**
 * Schema entries record type
 */
export type SchemaEntries = Record<string, VibSchema>;

/**
 * Core schemas bundle passed to args factories
 * Generic over ModelState for proper type inference
 */
export interface CoreSchemas<T extends ModelState = ModelState> {
  where: WhereSchema<T>;
  whereUnique: WhereUniqueSchema<T>;
  create: CreateSchema<T>;
  update: UpdateSchema<T>;
  select: SelectSchema<T>;
  include: IncludeSchema<T>;
  orderBy: OrderBySchema<T>;
  scalarCreate: ScalarCreateSchema<T>;
}

/**
 * Complete model schemas type
 * Used as explicit return type for getModelSchemas to avoid TS7056
 */
export interface ModelSchemas<T extends ModelState> {
  _filter: {
    scalar: ScalarFilterSchema<T>;
    unique: UniqueFilterSchema<T>;
    relation: RelationFilterSchema<T>;
    compoundConstraint: ReturnType<typeof getCompoundConstraintFilter<T>>;
    compoundId: ReturnType<typeof getCompoundIdFilter<T>>;
  };
  _create: {
    scalar: ScalarCreateSchema<T>;
    relation: RelationCreateSchema<T>;
  };
  _update: {
    scalar: ScalarUpdateSchema<T>;
    relation: RelationUpdateSchema<T>;
  };

  // Combined schemas
  where: WhereSchema<T>;
  whereUnique: WhereUniqueSchema<T>;
  create: CreateSchema<T>;
  update: UpdateSchema<T>;
  select: SelectSchema<T>;
  include: IncludeSchema<T>;
  orderBy: OrderBySchema<T>;

  // Args schemas for each operation
  args: {
    findUnique: ReturnType<typeof getFindUniqueArgs<T>>;
    findFirst: ReturnType<typeof getFindFirstArgs<T>>;
    findMany: ReturnType<typeof getFindManyArgs<T>>;
    create: ReturnType<typeof getCreateArgs<T>>;
    createMany: ReturnType<typeof getCreateManyArgs<T>>;
    update: ReturnType<typeof getUpdateArgs<T>>;
    updateMany: ReturnType<typeof getUpdateManyArgs<T>>;
    delete: ReturnType<typeof getDeleteArgs<T>>;
    deleteMany: ReturnType<typeof getDeleteManyArgs<T>>;
    upsert: ReturnType<typeof getUpsertArgs<T>>;
    count: ReturnType<typeof getCountArgs<T>>;
    aggregate: ReturnType<typeof getAggregateArgs<T>>;
    groupBy: ReturnType<typeof getGroupByArgs<T>>;
  };
}
