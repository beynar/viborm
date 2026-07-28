// Core schema factories - re-exports

// Create exports
export {
  type CreateSchema,
  getCreateSchema,
  getNestedScalarCreate,
  getNestedScalarCreateWithOmittedRequiredKeys,
  getRelationCreate,
  getScalarCreate,
  type NestedScalarCreateSchema,
  type NestedScalarCreateWithOmittedRequiredKeys,
  type RelationCreateSchema,
  type ScalarCreateSchema,
} from "./create";
// Filter exports
export {
  type CompoundConstraintFilterSchema,
  type CompoundIdFilterSchema,
  getCompoundConstraintFilter,
  getCompoundIdFilter,
  getRelationFilter,
  getScalarFilter,
  getUniqueFilter,
  type RelationFilterSchema,
  type ScalarFilterSchema,
  type UniqueFilterSchema,
} from "./filter";
// OrderBy exports
export {
  getOrderBySchema,
  type OrderBySchema,
  sortOrderSchema,
} from "./orderby";
// Select/Include exports
export {
  getIncludeSchema,
  getScalarSelectSchema,
  getSelectSchema,
  type IncludeSchema,
  type ScalarSelectSchema,
  type SelectSchema,
} from "./select";
// Update exports
export {
  getRelationUpdate,
  getScalarUpdate,
  getUpdateSchema,
  type RelationUpdateSchema,
  type ScalarUpdateSchema,
  type UpdateSchema,
} from "./update";
// Where exports
export {
  getScalarWhereSchema,
  getWhereSchema,
  getWhereUniqueExtendedSchema,
  getWhereUniqueSchema,
  type ScalarWhereSchema,
  type WhereSchema,
  type WhereUniqueExtendedSchema,
  type WhereUniqueSchema,
} from "./where";

// =============================================================================
// CORE SCHEMAS TYPE
// =============================================================================

import type { AnyModel } from "@schema/model";
import { lazyRecord } from "../../lazy";
import {
  getOmitSchema,
  getUpsertProjectionSchema,
  type OmitSchema,
  type UpsertProjectionSchema,
} from "../args/omit";
import type { ScalarSchemas } from "../index";
import {
  type CreateSchema,
  getCreateSchema,
  getNestedScalarCreate,
  getRelationCreate,
  getScalarCreate,
  type NestedScalarCreateSchema,
  type RelationCreateSchema,
  type ScalarCreateSchema,
} from "./create";
import {
  type CompoundConstraintFilterSchema,
  type CompoundIdFilterSchema,
  getCompoundConstraintFilter,
  getCompoundIdFilter,
  getRelationFilter,
  getScalarFilter,
  getUniqueFilter,
  type RelationFilterSchema,
  type ScalarFilterSchema,
  type UniqueFilterSchema,
} from "./filter";
import { getOrderBySchema, type OrderBySchema } from "./orderby";
import {
  getIncludeSchema,
  getScalarSelectSchema,
  getSelectSchema,
  type IncludeSchema,
  type ScalarSelectSchema,
  type SelectSchema,
} from "./select";
import {
  getRelationUpdate,
  getScalarUpdate,
  getUpdateSchema,
  type RelationUpdateSchema,
  type ScalarUpdateSchema,
  type UpdateSchema,
} from "./update";
import {
  getWhereSchema,
  getWhereUniqueExtendedSchema,
  getWhereUniqueSchema,
  type WhereSchema,
  type WhereUniqueExtendedSchema,
  type WhereUniqueSchema,
} from "./where";

/**
 * Type representing all core schemas for a model.
 * Used by args factories to reference schema types.
 */
export type CoreSchemas<M extends AnyModel, F extends ScalarSchemas<M>> = {
  scalarFilter: ScalarFilterSchema<M, F>;
  uniqueFilter: UniqueFilterSchema<M, F>;
  relationFilter: RelationFilterSchema<M, F>;
  compoundIdFilter: CompoundIdFilterSchema<M>;
  compoundConstraintFilter: CompoundConstraintFilterSchema<M>;
  scalarCreate: ScalarCreateSchema<M, F>;
  nestedScalarCreate: NestedScalarCreateSchema<M, F>;
  relationCreate: RelationCreateSchema<M, F>;
  scalarUpdate: ScalarUpdateSchema<M, F>;
  relationUpdate: RelationUpdateSchema<M, F>;
  where: WhereSchema<M, F>;
  /**
   * The STRICT unique selector: unique discriminators only. Used by `cursor` and
   * by every NESTED relation-write target selector (`connect`, `disconnect`,
   * `set`, nested `update`/`delete`/`upsert` `where`), which keep it deliberately
   * (W4-U1 scope).
   */
  whereUnique: WhereUniqueSchema<M, F>;
  /**
   * The EXTENDED unique selector (Prisma >= 4.5): discriminators PLUS non-unique
   * scalar filters and AND/OR/NOT. Used ONLY by the TOP-LEVEL `findUnique` /
   * `findUniqueOrThrow` / `update` / `delete` / `upsert` `where`.
   */
  whereUniqueExtended: WhereUniqueExtendedSchema<M, F>;
  create: CreateSchema<M, F>;
  update: UpdateSchema<M, F>;
  select: SelectSchema<M, F>;
  /**
   * The negative projection (see `src/validation/model/args/omit.ts`). Keyed on
   * the scalars a query may project, so a model-level `.omit()`-ed field cannot
   * even be named here.
   */
  omit: OmitSchema<M>;
  /**
   * `{ select?, include?, omit? }` on its own, for `upsert` — the one operation
   * with no whole-args parse to desugar `omit` inside of.
   */
  upsertProjection: UpsertProjectionSchema<M, F>;
  /** The scalar-only projection used by the bulk writes (see `ScalarSelectSchema`). */
  scalarSelect: ScalarSelectSchema<M>;
  include: IncludeSchema<F>;
  orderBy: OrderBySchema<M, F>;
};

export const getCoreSchemas = <M extends AnyModel, F extends ScalarSchemas<M>>(
  model: M,
  fieldSchemas: F
): CoreSchemas<M, F> => {
  // Each core schema is built on first access and memoized. Consumers only ever
  // read individual keys (e.g. `core.where`, `core.whereUnique`), so a query
  // pays only for the schemas its operation actually references.
  const core: CoreSchemas<M, F> = lazyRecord<CoreSchemas<M, F>>({
    scalarFilter: () => getScalarFilter<M, F>(fieldSchemas),
    uniqueFilter: () => getUniqueFilter(model, fieldSchemas),
    relationFilter: () => getRelationFilter<M, F>(fieldSchemas),
    compoundIdFilter: () => getCompoundIdFilter(model),
    compoundConstraintFilter: () => getCompoundConstraintFilter(model),
    scalarCreate: () => getScalarCreate(model, fieldSchemas),
    nestedScalarCreate: () => getNestedScalarCreate(model, fieldSchemas),
    relationCreate: () => getRelationCreate<M, F>(fieldSchemas),
    scalarUpdate: () => getScalarUpdate<M, F>(fieldSchemas),
    relationUpdate: () => getRelationUpdate<M, F>(fieldSchemas),
    where: () => getWhereSchema<M, F>(model, fieldSchemas),
    whereUnique: () => getWhereUniqueSchema(model, fieldSchemas),
    whereUniqueExtended: () =>
      getWhereUniqueExtendedSchema(model, fieldSchemas),
    create: () => getCreateSchema(model, fieldSchemas),
    update: () => getUpdateSchema<M, F>(fieldSchemas),
    select: () => getSelectSchema(model, fieldSchemas),
    omit: () => getOmitSchema(model),
    // Self-referential, and safe: `lazyRecord` builds each entry on first
    // access, long after `core` is bound.
    upsertProjection: () => getUpsertProjectionSchema(model, core),
    scalarSelect: () => getScalarSelectSchema(model),
    include: () => getIncludeSchema(model, fieldSchemas),
    orderBy: () => getOrderBySchema<M, F>(model, fieldSchemas),
  });
  return core;
};
