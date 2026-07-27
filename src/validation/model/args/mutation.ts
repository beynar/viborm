// Mutation operation args schema factories

import {
  type CacheInvalidationSchema,
  cacheInvalidationSchema,
} from "@cache/schema";
import type { AnyModel } from "@schema/model";
import v, { type V } from "../../primitives/v";
import type { CoreSchemas } from "../core";
import type { ScalarSchemas } from "../index";
import { restrictToScalarProjection } from "./bulk-write-projection";
import { type BulkWriteLimitSchema, bulkWriteLimit } from "./pagination";
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
 * CreateMany args: { data: create[], skipDuplicates?, select? }
 *
 * IMPLICIT RETURNING (the replacement for the removed `createManyAndReturn`):
 * `select` is optional, and its PRESENCE is what makes the operation return the
 * created rows instead of `{ count }`.
 *
 * That `select` is SCALAR-ONLY (`core.scalarSelect`), and `include` is refused
 * outright: viborm does not project relations into a bulk write's returned rows.
 * See `restrictToScalarProjection` for why — it replaces a projection that
 * returned silently wrong values — and for the message both refusals carry.
 */
export type CreateManyArgs<
  M extends AnyModel,
  F extends ScalarSchemas<M>,
> = V.Object<
  {
    data: V.Array<CoreSchemas<M, F>["scalarCreate"]>;
    skipDuplicates: V.Boolean<{ optional: true }>;
    select: CoreSchemas<M, F>["scalarSelect"];
    cache: CacheInvalidationSchema;
  },
  { atLeast: ["data"] }
>;
export const getCreateManyArgs = <
  M extends AnyModel,
  F extends ScalarSchemas<M>,
>(
  model: M,
  core: CoreSchemas<M, F>
): CreateManyArgs<M, F> => {
  return restrictToScalarProjection(
    v.object(
      {
        data: v.lazyRef(() => v.array(core.scalarCreate)),
        skipDuplicates: v.boolean({ optional: true }),
        select: v.lazyRef(() => core.scalarSelect),
        cache: cacheInvalidationSchema,
      },
      { atLeast: ["data"] }
    ),
    model,
    "createMany"
  );
};

// =============================================================================
// UPDATE ARGS
// =============================================================================

/**
 * Update args: { where: whereUniqueExtended, data: update, select?, include? }
 *
 * `where` is the EXTENDED unique selector (Prisma >= 4.5): at least one unique
 * discriminator, plus any non-unique scalar filters / AND / OR / NOT. A unique
 * key that matches while an extra filter excludes the row is a NOT-FOUND, not a
 * silent no-op — see `docs/content/docs/client/`.
 */
export type UpdateArgs<
  M extends AnyModel,
  F extends ScalarSchemas<M>,
> = V.Object<
  {
    where: CoreSchemas<M, F>["whereUniqueExtended"];
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
        where: v.lazyRef(() => core.whereUniqueExtended),
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
 * UpdateMany args: { where?, data: scalarUpdate, select? }
 *
 * `data` binds to the SCALAR-ONLY update schema (Prisma parity:
 * UpdateManyMutationInput excludes relation fields). A bulk UPDATE cannot
 * express nested relation writes, so a relation key in `data` must reject
 * loudly at the parse boundary (strict object → "Unknown key: <relation>")
 * instead of ever reaching the SET builder, which skips relations.
 *
 * IMPLICIT RETURNING (the replacement for the removed `updateManyAndReturn`):
 * `select` is optional, and its PRESENCE is what makes the operation return the
 * updated rows instead of `{ count }`. That `select` is SCALAR-ONLY and
 * `include` is refused, exactly as on `createMany` (see
 * `restrictToScalarProjection`).
 *
 * `limit` (Prisma 6.x) caps how many rows the UPDATE affects — including on the
 * returning arm, where exactly the capped rows come back. WHICH rows is
 * deliberately unspecified: a bulk write takes no `orderBy`.
 */
export type UpdateManyArgs<
  M extends AnyModel,
  F extends ScalarSchemas<M>,
> = V.Object<
  {
    where: CoreSchemas<M, F>["where"];
    data: CoreSchemas<M, F>["scalarUpdate"];
    select: CoreSchemas<M, F>["scalarSelect"];
    limit: BulkWriteLimitSchema;
    cache: CacheInvalidationSchema;
  },
  { atLeast: ["data"] }
>;
export const getUpdateManyArgs = <
  M extends AnyModel,
  F extends ScalarSchemas<M>,
>(
  model: M,
  core: CoreSchemas<M, F>
): UpdateManyArgs<M, F> => {
  return restrictToScalarProjection(
    v.object(
      {
        where: v.lazyRef(() => core.where),
        data: v.lazyRef(() => core.scalarUpdate),
        select: v.lazyRef(() => core.scalarSelect),
        limit: bulkWriteLimit(),
        cache: cacheInvalidationSchema,
      },
      { atLeast: ["data"] }
    ),
    model,
    "updateMany"
  );
};

// =============================================================================
// DELETE ARGS
// =============================================================================

/**
 * Delete args: { where: whereUniqueExtended, select?, include? }
 *
 * `where` is the EXTENDED unique selector (Prisma >= 4.5) — see UpdateArgs.
 */
export type DeleteArgs<
  M extends AnyModel,
  F extends ScalarSchemas<M>,
> = V.Object<
  {
    where: CoreSchemas<M, F>["whereUniqueExtended"];
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
        where: v.lazyRef(() => core.whereUniqueExtended),
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
 * DeleteMany args: { where?, select? }
 *
 * IMPLICIT RETURNING, extended past Prisma (which has no returning `deleteMany`
 * at all): `select` is optional, and its PRESENCE makes the operation return the
 * deleted rows instead of `{ count }`. That `select` is SCALAR-ONLY and
 * `include` is refused, for the same reason as the other bulk writes (see
 * `restrictToScalarProjection`).
 *
 * `limit` (Prisma 6.x) caps how many rows the DELETE removes — see
 * `UpdateManyArgs` for the "how many, not which" contract.
 */
export type DeleteManyArgs<
  M extends AnyModel,
  F extends ScalarSchemas<M>,
> = V.Object<
  {
    where: CoreSchemas<M, F>["where"];
    select: CoreSchemas<M, F>["scalarSelect"];
    limit: BulkWriteLimitSchema;
    cache: CacheInvalidationSchema;
  },
  { optional: true }
>;
export const getDeleteManyArgs = <
  M extends AnyModel,
  F extends ScalarSchemas<M>,
>(
  model: M,
  core: CoreSchemas<M, F>
): DeleteManyArgs<M, F> => {
  return restrictToScalarProjection(
    v.object(
      {
        where: v.lazyRef(() => core.where),
        select: v.lazyRef(() => core.scalarSelect),
        limit: bulkWriteLimit(),
        cache: cacheInvalidationSchema,
      },
      { optional: true }
    ),
    model,
    "deleteMany"
  );
};

// =============================================================================
// UPSERT ARGS
// =============================================================================

/**
 * Upsert args: { where: whereUniqueExtended, create, update, select?, include?, cache?, targetWhere?, setWhere? }
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
    where: CoreSchemas<M, F>["whereUniqueExtended"];
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
        where: v.lazyRef(() => core.whereUniqueExtended),
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
