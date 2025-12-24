// Mutation operation args schema factories

import {
  object,
  optional,
  boolean,
  array,
  type ObjectSchema,
  type OptionalSchema,
  type BooleanSchema,
  type ArraySchema,
  type InferInput,
} from "valibot";
import type { ModelState } from "../../model";
import type { CoreSchemas } from "../types";
import type {
  WhereSchema,
  WhereUniqueSchema,
  CreateSchema,
  UpdateSchema,
  SelectSchema,
  IncludeSchema,
  ScalarCreateSchema,
} from "../core";

// =============================================================================
// CREATE ARGS
// =============================================================================

/** Create args schema: { data, select?, include? } */
export type CreateArgsSchema<T extends ModelState> = ObjectSchema<
  {
    data: CreateSchema<T>;
    select: OptionalSchema<SelectSchema<T>, undefined>;
    include: OptionalSchema<IncludeSchema<T>, undefined>;
  },
  undefined
>;

/** Input type for create args */
export type CreateArgsInput<T extends ModelState> = InferInput<
  CreateArgsSchema<T>
>;

/**
 * Create args: { data: create, select?, include? }
 */
export const getCreateArgs = <T extends ModelState>(
  core: CoreSchemas<T>
): CreateArgsSchema<T> => {
  return object({
    data: core.create,
    select: optional(core.select),
    include: optional(core.include),
  }) as CreateArgsSchema<T>;
};

// =============================================================================
// CREATE MANY ARGS
// =============================================================================

/** CreateMany args schema: { data[], skipDuplicates? } */
export type CreateManyArgsSchema<T extends ModelState> = ObjectSchema<
  {
    data: ArraySchema<ScalarCreateSchema<T>, undefined>;
    skipDuplicates: OptionalSchema<BooleanSchema<undefined>, undefined>;
  },
  undefined
>;

/** Input type for createMany args */
export type CreateManyArgsInput<T extends ModelState> = InferInput<
  CreateManyArgsSchema<T>
>;

/**
 * CreateMany args: { data: create[], skipDuplicates? }
 */
export const getCreateManyArgs = <T extends ModelState>(
  core: CoreSchemas<T>
): CreateManyArgsSchema<T> => {
  return object({
    data: array(core.scalarCreate),
    skipDuplicates: optional(boolean()),
  }) as CreateManyArgsSchema<T>;
};

// =============================================================================
// UPDATE ARGS
// =============================================================================

/** Update args schema: { where, data, select?, include? } */
export type UpdateArgsSchema<T extends ModelState> = ObjectSchema<
  {
    where: WhereUniqueSchema<T>;
    data: UpdateSchema<T>;
    select: OptionalSchema<SelectSchema<T>, undefined>;
    include: OptionalSchema<IncludeSchema<T>, undefined>;
  },
  undefined
>;

/** Input type for update args */
export type UpdateArgsInput<T extends ModelState> = InferInput<
  UpdateArgsSchema<T>
>;

/**
 * Update args: { where: whereUnique, data: update, select?, include? }
 */
export const getUpdateArgs = <T extends ModelState>(
  core: CoreSchemas<T>
): UpdateArgsSchema<T> => {
  return object({
    where: core.whereUnique,
    data: core.update,
    select: optional(core.select),
    include: optional(core.include),
  }) as UpdateArgsSchema<T>;
};

// =============================================================================
// UPDATE MANY ARGS
// =============================================================================

/** UpdateMany args schema: { where?, data } */
export type UpdateManyArgsSchema<T extends ModelState> = ObjectSchema<
  {
    where: OptionalSchema<WhereSchema<T>, undefined>;
    data: UpdateSchema<T>;
  },
  undefined
>;

/** Input type for updateMany args */
export type UpdateManyArgsInput<T extends ModelState> = InferInput<
  UpdateManyArgsSchema<T>
>;

/**
 * UpdateMany args: { where?, data: update }
 */
export const getUpdateManyArgs = <T extends ModelState>(
  core: CoreSchemas<T>
): UpdateManyArgsSchema<T> => {
  return object({
    where: optional(core.where),
    data: core.update,
  }) as UpdateManyArgsSchema<T>;
};

// =============================================================================
// DELETE ARGS
// =============================================================================

/** Delete args schema: { where, select?, include? } */
export type DeleteArgsSchema<T extends ModelState> = ObjectSchema<
  {
    where: WhereUniqueSchema<T>;
    select: OptionalSchema<SelectSchema<T>, undefined>;
    include: OptionalSchema<IncludeSchema<T>, undefined>;
  },
  undefined
>;

/** Input type for delete args */
export type DeleteArgsInput<T extends ModelState> = InferInput<
  DeleteArgsSchema<T>
>;

/**
 * Delete args: { where: whereUnique, select?, include? }
 */
export const getDeleteArgs = <T extends ModelState>(
  core: CoreSchemas<T>
): DeleteArgsSchema<T> => {
  return object({
    where: core.whereUnique,
    select: optional(core.select),
    include: optional(core.include),
  }) as DeleteArgsSchema<T>;
};

// =============================================================================
// DELETE MANY ARGS
// =============================================================================

/** DeleteMany args schema: { where? } */
export type DeleteManyArgsSchema<T extends ModelState> = ObjectSchema<
  {
    where: OptionalSchema<WhereSchema<T>, undefined>;
  },
  undefined
>;

/** Input type for deleteMany args */
export type DeleteManyArgsInput<T extends ModelState> = InferInput<
  DeleteManyArgsSchema<T>
>;

/**
 * DeleteMany args: { where? }
 */
export const getDeleteManyArgs = <T extends ModelState>(
  core: CoreSchemas<T>
): DeleteManyArgsSchema<T> => {
  return object({
    where: optional(core.where),
  }) as DeleteManyArgsSchema<T>;
};

// =============================================================================
// UPSERT ARGS
// =============================================================================

/** Upsert args schema: { where, create, update, select?, include? } */
export type UpsertArgsSchema<T extends ModelState> = ObjectSchema<
  {
    where: WhereUniqueSchema<T>;
    create: CreateSchema<T>;
    update: UpdateSchema<T>;
    select: OptionalSchema<SelectSchema<T>, undefined>;
    include: OptionalSchema<IncludeSchema<T>, undefined>;
  },
  undefined
>;

/** Input type for upsert args */
export type UpsertArgsInput<T extends ModelState> = InferInput<
  UpsertArgsSchema<T>
>;

/**
 * Upsert args: { where: whereUnique, create, update, select?, include? }
 */
export const getUpsertArgs = <T extends ModelState>(
  core: CoreSchemas<T>
): UpsertArgsSchema<T> => {
  return object({
    where: core.whereUnique,
    create: core.create,
    update: core.update,
    select: optional(core.select),
    include: optional(core.include),
  }) as UpsertArgsSchema<T>;
};

