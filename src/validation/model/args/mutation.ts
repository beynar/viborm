// Mutation operation args schema factories

import {
  type CacheInvalidationSchema,
  cacheInvalidationSchema,
} from "@cache/schema";
import type { AnyModel } from "@schema/model";
import v, { type V } from "@validation";
import type { FieldSchemas } from "../index";
import type { CoreSchemas } from "../core";
// =============================================================================
// CREATE ARGS
// =============================================================================

/**
 * Create args: { data: create, select?, include? }
 */
export type CreateArgs<
  M extends AnyModel,
  F extends FieldSchemas<M>,
> = V.Object<
  {
    data: CoreSchemas<M, F>["create"];
    select: CoreSchemas<M, F>["select"];
    include: CoreSchemas<M, F>["include"];
    cache: CacheInvalidationSchema;
  },
  { atLeast: ["data"] }
>;
export const getCreateArgs = <
  M extends AnyModel,
  F extends FieldSchemas<M>,
>(
  core: CoreSchemas<M, F>
): CreateArgs<M, F> => {
  return v.object(
    {
      data: core.create,
      select: core.select,
      include: core.include,
      cache: cacheInvalidationSchema,
    },
    { atLeast: ["data"] }
  );
};

// =============================================================================
// CREATE MANY ARGS
// =============================================================================

/**
 * CreateMany args: { data: create[], skipDuplicates? }
 */
export type CreateManyArgs<
  M extends AnyModel,
  F extends FieldSchemas<M>,
> = V.Object<
  {
    data: V.Array<CoreSchemas<M, F>["scalarCreate"]>;
    skipDuplicates: V.Boolean<{ optional: true }>;
    cache: CacheInvalidationSchema;
  },
  { atLeast: ["data"] }
>;
export const getCreateManyArgs = <
  M extends AnyModel,
  F extends FieldSchemas<M>,
>(
  core: CoreSchemas<M, F>
): CreateManyArgs<M, F> => {
  return v.object(
    {
      data: v.array(core.scalarCreate),
      skipDuplicates: v.boolean({ optional: true }),
      cache: cacheInvalidationSchema,
    },
    { atLeast: ["data"] }
  );
};

// =============================================================================
// UPDATE ARGS
// =============================================================================

/**
 * Update args: { where: whereUnique, data: update, select?, include? }
 */
export type UpdateArgs<
  M extends AnyModel,
  F extends FieldSchemas<M>,
> = V.Object<
  {
    where: CoreSchemas<M, F>["whereUnique"];
    data: CoreSchemas<M, F>["update"];
    select: CoreSchemas<M, F>["select"];
    include: CoreSchemas<M, F>["include"];
    cache: CacheInvalidationSchema;
  },
  { atLeast: ["where", "data"] }
>;

export const getUpdateArgs = <
  M extends AnyModel,
  F extends FieldSchemas<M>,
>(
  core: CoreSchemas<M, F>
): UpdateArgs<M, F> => {
  return v.object(
    {
      where: core.whereUnique,
      data: core.update,
      select: core.select,
      include: core.include,
      cache: cacheInvalidationSchema,
    },
    { atLeast: ["where", "data"] }
  );
};

// =============================================================================
// UPDATE MANY ARGS
// =============================================================================

/**
 * UpdateMany args: { where?, data: update }
 */
export type UpdateManyArgs<
  M extends AnyModel,
  F extends FieldSchemas<M>,
> = V.Object<
  {
    where: CoreSchemas<M, F>["where"];
    data: CoreSchemas<M, F>["update"];
    cache: CacheInvalidationSchema;
  },
  { atLeast: ["data"] }
>;
export const getUpdateManyArgs = <
  M extends AnyModel,
  F extends FieldSchemas<M>,
>(
  core: CoreSchemas<M, F>
): UpdateManyArgs<M, F> => {
  return v.object(
    {
      where: core.where,
      data: core.update,
      cache: cacheInvalidationSchema,
    },
    { atLeast: ["data"] }
  );
};

// =============================================================================
// DELETE ARGS
// =============================================================================

/**
 * Delete args: { where: whereUnique, select?, include? }
 */
export type DeleteArgs<
  M extends AnyModel,
  F extends FieldSchemas<M>,
> = V.Object<
  {
    where: CoreSchemas<M, F>["whereUnique"];
    select: CoreSchemas<M, F>["select"];
    include: CoreSchemas<M, F>["include"];
    cache: CacheInvalidationSchema;
  },
  { atLeast: ["where"] }
>;
export const getDeleteArgs = <
  M extends AnyModel,
  F extends FieldSchemas<M>,
>(
  core: CoreSchemas<M, F>
): DeleteArgs<M, F> => {
  return v.object(
    {
      where: core.whereUnique,
      select: core.select,
      include: core.include,
      cache: cacheInvalidationSchema,
    },
    { atLeast: ["where"] }
  );
};

// =============================================================================
// DELETE MANY ARGS
// =============================================================================

/**
 * DeleteMany args: { where? }
 */
export type DeleteManyArgs<
  M extends AnyModel,
  F extends FieldSchemas<M>,
> = V.Object<
  {
    where: CoreSchemas<M, F>["where"];
    cache: CacheInvalidationSchema;
  },
  { optional: true }
>;
export const getDeleteManyArgs = <
  M extends AnyModel,
  F extends FieldSchemas<M>,
>(
  core: CoreSchemas<M, F>
): DeleteManyArgs<M, F> => {
  return v.object(
    {
      where: core.where,
      cache: cacheInvalidationSchema,
    },
    { optional: true }
  );
};

// =============================================================================
// UPSERT ARGS
// =============================================================================

/**
 * Upsert args: { where: whereUnique, create, update, select?, include?, cache?, targetWhere?, setWhere? }
 *
 * Additional options for advanced ON CONFLICT handling:
 * - targetWhere: WHERE clause for partial unique index matching
 *                PostgreSQL: ON CONFLICT (id) WHERE <targetWhere> DO UPDATE ...
 * - setWhere: WHERE clause for conditional updates
 *             PostgreSQL: ON CONFLICT ... DO UPDATE SET x = y WHERE <setWhere>
 */
export type UpsertArgs<
  M extends AnyModel,
  F extends FieldSchemas<M>,
> = V.Object<
  {
    where: CoreSchemas<M, F>["whereUnique"];
    create: CoreSchemas<M, F>["create"];
    update: CoreSchemas<M, F>["update"];
    select: CoreSchemas<M, F>["select"];
    include: CoreSchemas<M, F>["include"];
    cache: CacheInvalidationSchema;
    /** WHERE clause for partial unique index matching (PostgreSQL/SQLite only) */
    targetWhere: CoreSchemas<M, F>["where"];
    /** WHERE clause for conditional updates (PostgreSQL/SQLite only) */
    setWhere: CoreSchemas<M, F>["where"];
  },
  { atLeast: ["where", "create", "update"] }
>;

export const getUpsertArgs = <
  M extends AnyModel,
  F extends FieldSchemas<M>,
>(
  core: CoreSchemas<M, F>
): UpsertArgs<M, F> => {
  return v.object(
    {
      where: core.whereUnique,
      create: core.create,
      update: core.update,
      select: core.select,
      include: core.include,
      cache: cacheInvalidationSchema,
      targetWhere: core.where,
      setWhere: core.where,
    },
    { atLeast: ["where", "create", "update"] }
  );
};
