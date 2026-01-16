// Mutation operation args schema factories

import { type CacheInvalidationSchema, cacheInvalidationSchema } from "@cache/schema";
import v, { type V } from "@validation";
import type { ModelState } from "../../model";
import type { CoreSchemas } from "../core";
// =============================================================================
// CREATE ARGS
// =============================================================================

/**
 * Create args: { data: create, select?, include? }
 */
export type CreateArgs<T extends ModelState> = V.Object<
  {
    data: CoreSchemas<T>["create"];
    select: CoreSchemas<T>["select"];
    include: CoreSchemas<T>["include"];
    cache: CacheInvalidationSchema;
  },
  { atLeast: ["data"] }
>;
export const getCreateArgs = <T extends ModelState>(
  core: CoreSchemas<T>
): CreateArgs<T> => {
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
export type CreateManyArgs<T extends ModelState> = V.Object<
  {
    data: V.Array<CoreSchemas<T>["scalarCreate"]>;
    skipDuplicates: V.Boolean<{ optional: true }>;
    cache: CacheInvalidationSchema;
  },
  { atLeast: ["data"] }
>;
export const getCreateManyArgs = <T extends ModelState>(
  core: CoreSchemas<T>
): CreateManyArgs<T> => {
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
export type UpdateArgs<T extends ModelState> = V.Object<
  {
    where: CoreSchemas<T>["whereUnique"];
    data: CoreSchemas<T>["update"];
    select: CoreSchemas<T>["select"];
    include: CoreSchemas<T>["include"];
    cache: CacheInvalidationSchema;
  },
  { atLeast: ["where", "data"] }
>;

export const getUpdateArgs = <T extends ModelState>(
  core: CoreSchemas<T>
): UpdateArgs<T> => {
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
export type UpdateManyArgs<T extends ModelState> = V.Object<
  {
    where: CoreSchemas<T>["where"];
    data: CoreSchemas<T>["update"];
    cache: CacheInvalidationSchema;
  },
  { atLeast: ["data"] }
>;
export const getUpdateManyArgs = <T extends ModelState>(
  core: CoreSchemas<T>
): UpdateManyArgs<T> => {
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
export type DeleteArgs<T extends ModelState> = V.Object<
  {
    where: CoreSchemas<T>["whereUnique"];
    select: CoreSchemas<T>["select"];
    include: CoreSchemas<T>["include"];
    cache: CacheInvalidationSchema;
  },
  { atLeast: ["where"] }
>;
export const getDeleteArgs = <T extends ModelState>(
  core: CoreSchemas<T>
): DeleteArgs<T> => {
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
export type DeleteManyArgs<T extends ModelState> = V.Object<
  {
    where: CoreSchemas<T>["where"];
    cache: CacheInvalidationSchema;
  },
  { optional: true }
>;
export const getDeleteManyArgs = <T extends ModelState>(
  core: CoreSchemas<T>
): DeleteManyArgs<T> => {
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
 * Upsert args: { where: whereUnique, create, update, select?, include?, cache? }
 */
export type UpsertArgs<T extends ModelState> = V.Object<
  {
    where: CoreSchemas<T>["whereUnique"];
    create: CoreSchemas<T>["create"];
    update: CoreSchemas<T>["update"];
    select: CoreSchemas<T>["select"];
    include: CoreSchemas<T>["include"];
    cache: CacheInvalidationSchema;
  },
  { atLeast: ["where", "create", "update"] }
>;

export const getUpsertArgs = <T extends ModelState>(
  core: CoreSchemas<T>
): UpsertArgs<T> => {
  return v.object(
    {
      where: core.whereUnique,
      create: core.create,
      update: core.update,
      select: core.select,
      include: core.include,
      cache: cacheInvalidationSchema,
    },
    { atLeast: ["where", "create", "update"] }
  );
};
