// Runtime Index
// Re-exports all ArkType runtime schema builders

import { Type } from "arktype";
import type { Model } from "../model";
import type { FieldRecord } from "../types";

// =============================================================================
// IMPORTS FOR buildModelSchemas
// =============================================================================

// Phase 1 (scalar) schema builders
import {
  buildWhereScalarSchema,
  buildWhereUniqueSchema,
  buildCreateScalarSchema,
  buildCreateManySchema,
  buildUpdateScalarSchema,
  buildSelectSchema,
  buildIncludeSchema,
  buildOrderBySchema,
  // Phase 2 (full) schema builders
  buildWhereSchema,
  buildCreateSchema,
  buildUpdateSchema,
} from "./core-schemas";

import {
  buildFindManyArgsSchema,
  buildFindFirstArgsSchema,
  buildFindUniqueArgsSchema,
  buildCountArgsSchema,
  buildExistArgsSchema,
  buildAggregateArgsSchema,
  buildGroupByArgsSchema,
} from "./args-schemas";

import {
  buildCreateArgsSchema,
  buildUpdateArgsSchema,
  buildUpdateManyArgsSchema,
  buildDeleteArgsSchema,
  buildDeleteManyArgsSchema,
  buildUpsertArgsSchema,
} from "./mutation-schemas";

import {
  buildUncheckedCreateSchema,
  buildUncheckedUpdateSchema,
} from "./unchecked-schemas";

import {
  buildSelectNestedSchema,
  buildIncludeNestedSchema,
} from "./nested-schemas";

// =============================================================================
// RE-EXPORTS
// =============================================================================

export {
  // Phase 1 (scalar) builders
  buildWhereScalarSchema,
  buildWhereUniqueSchema,
  buildCreateScalarSchema,
  buildCreateManySchema,
  buildUpdateScalarSchema,
  buildSelectSchema,
  buildIncludeSchema,
  buildOrderBySchema,
  // Phase 2 (full) builders
  buildWhereSchema,
  buildCreateSchema,
  buildUpdateSchema,
} from "./core-schemas";

export {
  buildFindManyArgsSchema,
  buildFindFirstArgsSchema,
  buildFindUniqueArgsSchema,
  buildCountArgsSchema,
  buildExistArgsSchema,
  buildAggregateArgsSchema,
  buildGroupByArgsSchema,
} from "./args-schemas";

export {
  buildCreateArgsSchema,
  buildUpdateArgsSchema,
  buildUpdateManyArgsSchema,
  buildDeleteArgsSchema,
  buildDeleteManyArgsSchema,
  buildUpsertArgsSchema,
} from "./mutation-schemas";

export {
  buildUncheckedCreateSchema,
  buildUncheckedUpdateSchema,
} from "./unchecked-schemas";

export {
  buildSelectNestedSchema,
  buildIncludeNestedSchema,
} from "./nested-schemas";

// =============================================================================
// TYPED MODEL SCHEMAS INTERFACE
// =============================================================================

/**
 * Phase 1 Schemas - Scalar only, no cross-model dependencies.
 * Built in Model constructor, always available after instantiation.
 * These schemas only depend on the current model's scalar fields.
 */
export interface ScalarSchemas {
  /** Scalar field filters only (no relation filters) */
  whereScalar: Type;
  /** Unique field filters (already scalar-only) */
  whereUnique: Type;
  /** Scalar fields for create (no nested relations) */
  createScalar: Type;
  /** Create many envelope (already scalar-only) */
  createMany: Type;
  /** Scalar fields for update (no nested relations) */
  updateScalar: Type;
  /** Simple boolean select for fields */
  select: Type;
  /** Simple boolean include for relations */
  include: Type;
  /** Order by scalar fields */
  orderBy: Type;
  /** Unchecked create (scalar + FK fields) */
  uncheckedCreate: Type;
  /** Unchecked update (scalar + FK fields) */
  uncheckedUpdate: Type;
}

/**
 * Phase 2 Schemas - Full schemas with relation support.
 * Built during hydration when all models' ScalarSchemas exist.
 * Includes relation filters, nested creates/updates, etc.
 */
export interface FullSchemas {
  /** Full where with scalar + relation filters */
  where: Type;
  /** Full create with scalar + nested relation creates */
  create: Type;
  /** Full update with scalar + nested relation updates */
  update: Type;
  /** Nested select with recursive relation selection */
  selectNested: Type;
  /** Nested include with recursive relation inclusion */
  includeNested: Type;
}

/**
 * Legacy CoreSchemas interface for args builders.
 * Combines scalar schemas with full schemas.
 */
export interface CoreSchemas extends ScalarSchemas, FullSchemas {}

/**
 * Runtime schemas for a model.
 * Uses Type (without generic) to avoid deep ArkType type inference.
 * The actual types are enforced at the function return level.
 */
export interface TypedModelSchemas<TFields extends FieldRecord>
  extends CoreSchemas {
  // Query operation args types
  findMany: Type;
  findFirst: Type;
  findUnique: Type;
  count: Type;
  exist: Type;
  aggregate: Type;
  groupBy: Type;

  // Mutation operation args types
  createArgs: Type;
  updateArgs: Type;
  updateManyArgs: Type;
  deleteArgs: Type;
  deleteManyArgs: Type;
  upsertArgs: Type;
}

// =============================================================================
// BUILD MODEL SCHEMAS (Two-Phase)
// =============================================================================

/**
 * Phase 1: Builds scalar-only schemas for a model.
 * No cross-model dependencies - safe to build in Model constructor.
 * Called during Model instantiation.
 */
export const buildScalarSchemas = <TFields extends FieldRecord>(
  model: Model<any>
): ScalarSchemas => {
  return {
    whereScalar: buildWhereScalarSchema(model),
    // whereUnique: buildWhereUniqueSchema(model),
    // createScalar: buildCreateScalarSchema(model),
    // createMany: buildCreateManySchema(model),
    // updateScalar: buildUpdateScalarSchema(model),
    // select: buildSelectSchema(model),
    // include: buildIncludeSchema(model),
    // orderBy: buildOrderBySchema(model),
    // uncheckedCreate: buildUncheckedCreateSchema(model),
    // uncheckedUpdate: buildUncheckedUpdateSchema(model),
  };
};

/**
 * Phase 2: Builds full schemas with relation support.
 * Requires all models' ScalarSchemas to exist (built during hydration).
 * Full schemas build the combined scalar+relation shape directly.
 */
export const buildFullSchemas = <TFields extends FieldRecord>(
  model: Model<any>,
  scalar: ScalarSchemas
): TypedModelSchemas<TFields> => {
  // Build full schemas (they build combined shape directly, including scalar fields)
  const full: FullSchemas = {
    where: buildWhereSchema(model),
    // create: buildCreateSchema(model),
    // update: buildUpdateSchema(model),
    // selectNested: buildSelectNestedSchema(model),
    // includeNested: buildIncludeNestedSchema(model),
  };

  // Combine scalar + full into CoreSchemas
  // const core: CoreSchemas = {
  //   ...scalar,
  //   ...full,
  // };

  // Build args schemas using core schemas
  // return {
  //   ...core,

  //   // Query operation args (some need model for field-specific schemas)
  //   findMany: buildFindManyArgsSchema(model, core),
  //   findFirst: buildFindFirstArgsSchema(model, core),
  //   findUnique: buildFindUniqueArgsSchema(core),
  //   count: buildCountArgsSchema(model, core),
  //   exist: buildExistArgsSchema(core),
  //   aggregate: buildAggregateArgsSchema(model, core),
  //   groupBy: buildGroupByArgsSchema(model, core),

  //   // Mutation operation args (all use only core schemas)
  //   createArgs: buildCreateArgsSchema(core),
  //   updateArgs: buildUpdateArgsSchema(core),
  //   updateManyArgs: buildUpdateManyArgsSchema(core),
  //   deleteArgs: buildDeleteArgsSchema(core),
  //   deleteManyArgs: buildDeleteManyArgsSchema(core),
  //   upsertArgs: buildUpsertArgsSchema(core),
  // };
};

/**
 * Legacy: Builds all schemas for a model in a single pass.
 * @deprecated Use buildScalarSchemas + buildFullSchemas for proper two-phase building.
 */
export const buildModelSchemas = <TFields extends FieldRecord>(
  model: Model<any>
): TypedModelSchemas<TFields> => {
  const scalar = buildScalarSchemas<TFields>(model);
  return buildFullSchemas<TFields>(model, scalar);
};

// Legacy export
export type ModelSchemas = TypedModelSchemas<any>;
