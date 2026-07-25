// Mutation operation args schema factories

import {
  type CacheInvalidationSchema,
  cacheInvalidationSchema,
} from "@cache/schema";
import type { AnyModel } from "@schema/model";
import v, { type V } from "../../primitives/v";
import type { CoreSchemas } from "../core";
import type { ScalarSchemas } from "../index";
import { rejectSelectInclude } from "./select-include-exclusivity";
// =============================================================================
// CREATE ARGS
// =============================================================================

/**
 * Create args: { data: create, select?, include? }
 */
export type CreateArgs<
  M extends AnyModel,
  F extends ScalarSchemas<M>,
> = V.Object<
  {
    data: CoreSchemas<M, F>["create"];
    select: CoreSchemas<M, F>["select"];
    include: CoreSchemas<M, F>["include"];
    cache: CacheInvalidationSchema;
  },
  { atLeast: ["data"] }
>;
export const getCreateArgs = <M extends AnyModel, F extends ScalarSchemas<M>>(
  core: CoreSchemas<M, F>
): CreateArgs<M, F> => {
  return rejectSelectInclude(
    v.object(
      {
        data: v.lazyRef(() => core.create),
        select: v.lazyRef(() => core.select),
        include: v.lazyRef(() => core.include),
        cache: cacheInvalidationSchema,
      },
      { atLeast: ["data"] }
    )
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
  F extends ScalarSchemas<M>,
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
  F extends ScalarSchemas<M>,
>(
  core: CoreSchemas<M, F>
): CreateManyArgs<M, F> => {
  return v.object(
    {
      data: v.lazyRef(() => v.array(core.scalarCreate)),
      skipDuplicates: v.boolean({ optional: true }),
      cache: cacheInvalidationSchema,
    },
    { atLeast: ["data"] }
  );
};

// =============================================================================
// CREATE MANY AND RETURN ARGS
// =============================================================================

/**
 * CreateManyAndReturn args: { data: create[], skipDuplicates?, select? }
 * Like createMany but returns the created rows (select of scalars only;
 * include is not supported because rows are returned via RETURNING).
 */
export type CreateManyAndReturnArgs<
  M extends AnyModel,
  F extends ScalarSchemas<M>,
> = V.Object<
  {
    data: V.Array<CoreSchemas<M, F>["scalarCreate"]>;
    skipDuplicates: V.Boolean<{ optional: true }>;
    select: CoreSchemas<M, F>["select"];
    cache: CacheInvalidationSchema;
  },
  { atLeast: ["data"] }
>;
export const getCreateManyAndReturnArgs = <
  M extends AnyModel,
  F extends ScalarSchemas<M>,
>(
  core: CoreSchemas<M, F>
): CreateManyAndReturnArgs<M, F> => {
  return v.object(
    {
      data: v.lazyRef(() => v.array(core.scalarCreate)),
      skipDuplicates: v.boolean({ optional: true }),
      select: v.lazyRef(() => core.select),
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
  F extends ScalarSchemas<M>,
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

export const getUpdateArgs = <M extends AnyModel, F extends ScalarSchemas<M>>(
  core: CoreSchemas<M, F>
): UpdateArgs<M, F> => {
  return rejectSelectInclude(
    v.object(
      {
        where: v.lazyRef(() => core.whereUnique),
        data: v.lazyRef(() => core.update),
        select: v.lazyRef(() => core.select),
        include: v.lazyRef(() => core.include),
        cache: cacheInvalidationSchema,
      },
      { atLeast: ["where", "data"] }
    )
  );
};

// =============================================================================
// UPDATE MANY ARGS
// =============================================================================

/**
 * UpdateMany args: { where?, data: scalarUpdate }
 *
 * `data` binds to the SCALAR-ONLY update schema (Prisma parity:
 * UpdateManyMutationInput excludes relation fields). A bulk UPDATE cannot
 * express nested relation writes, so a relation key in `data` must reject
 * loudly at the parse boundary (strict object → "Unknown key: <relation>")
 * instead of ever reaching the SET builder, which skips relations.
 */
export type UpdateManyArgs<
  M extends AnyModel,
  F extends ScalarSchemas<M>,
> = V.Object<
  {
    where: CoreSchemas<M, F>["where"];
    data: CoreSchemas<M, F>["scalarUpdate"];
    cache: CacheInvalidationSchema;
  },
  { atLeast: ["data"] }
>;
export const getUpdateManyArgs = <
  M extends AnyModel,
  F extends ScalarSchemas<M>,
>(
  core: CoreSchemas<M, F>
): UpdateManyArgs<M, F> => {
  return v.object(
    {
      where: v.lazyRef(() => core.where),
      data: v.lazyRef(() => core.scalarUpdate),
      cache: cacheInvalidationSchema,
    },
    { atLeast: ["data"] }
  );
};

// =============================================================================
// UPDATE MANY AND RETURN ARGS
// =============================================================================

/**
 * UpdateManyAndReturn args: { where?, data: scalarUpdate, select? }
 * Like updateMany but returns the updated rows (select of scalars only;
 * include is not supported because rows are returned via RETURNING).
 *
 * `data` binds to the SCALAR-ONLY update schema for the same reason as
 * updateMany: a relation key must fail validation loudly, never be silently
 * discarded by the SET builder.
 */
export type UpdateManyAndReturnArgs<
  M extends AnyModel,
  F extends ScalarSchemas<M>,
> = V.Object<
  {
    where: CoreSchemas<M, F>["where"];
    data: CoreSchemas<M, F>["scalarUpdate"];
    select: CoreSchemas<M, F>["select"];
    cache: CacheInvalidationSchema;
  },
  { atLeast: ["data"] }
>;
export const getUpdateManyAndReturnArgs = <
  M extends AnyModel,
  F extends ScalarSchemas<M>,
>(
  core: CoreSchemas<M, F>
): UpdateManyAndReturnArgs<M, F> => {
  return v.object(
    {
      where: v.lazyRef(() => core.where),
      data: v.lazyRef(() => core.scalarUpdate),
      select: v.lazyRef(() => core.select),
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
  F extends ScalarSchemas<M>,
> = V.Object<
  {
    where: CoreSchemas<M, F>["whereUnique"];
    select: CoreSchemas<M, F>["select"];
    include: CoreSchemas<M, F>["include"];
    cache: CacheInvalidationSchema;
  },
  { atLeast: ["where"] }
>;
export const getDeleteArgs = <M extends AnyModel, F extends ScalarSchemas<M>>(
  core: CoreSchemas<M, F>
): DeleteArgs<M, F> => {
  return rejectSelectInclude(
    v.object(
      {
        where: v.lazyRef(() => core.whereUnique),
        select: v.lazyRef(() => core.select),
        include: v.lazyRef(() => core.include),
        cache: cacheInvalidationSchema,
      },
      { atLeast: ["where"] }
    )
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
  F extends ScalarSchemas<M>,
> = V.Object<
  {
    where: CoreSchemas<M, F>["where"];
    cache: CacheInvalidationSchema;
  },
  { optional: true }
>;
export const getDeleteManyArgs = <
  M extends AnyModel,
  F extends ScalarSchemas<M>,
>(
  core: CoreSchemas<M, F>
): DeleteManyArgs<M, F> => {
  return v.object(
    {
      where: v.lazyRef(() => core.where),
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
  F extends ScalarSchemas<M>,
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

export const getUpsertArgs = <M extends AnyModel, F extends ScalarSchemas<M>>(
  core: CoreSchemas<M, F>
): UpsertArgs<M, F> => {
  return rejectSelectInclude(
    v.object(
      {
        where: v.lazyRef(() => core.whereUnique),
        create: v.lazyRef(() => core.create),
        update: v.lazyRef(() => core.update),
        select: v.lazyRef(() => core.select),
        include: v.lazyRef(() => core.include),
        cache: cacheInvalidationSchema,
        targetWhere: v.lazyRef(() => core.where),
        setWhere: v.lazyRef(() => core.where),
      },
      { atLeast: ["where", "create", "update"] }
    )
  );
};
