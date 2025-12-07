// Runtime Index
// Re-exports all ArkType runtime schema builders

import { Type } from "arktype";
import type { Model } from "../model";
import type { FieldRecord } from "../types";

// =============================================================================
// IMPORTS FOR buildModelSchemas
// =============================================================================

import {
  buildWhereSchema,
  buildWhereUniqueSchema,
  buildCreateSchema,
  buildCreateManySchema,
  buildUpdateSchema,
  buildSelectSchema,
  buildIncludeSchema,
  buildOrderBySchema,
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
  buildWhereSchema,
  buildWhereUniqueSchema,
  buildCreateSchema,
  buildCreateManySchema,
  buildUpdateSchema,
  buildSelectSchema,
  buildIncludeSchema,
  buildOrderBySchema,
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
 * Core schemas built in phase 1 - used by args/mutation builders
 */
export interface CoreSchemas {
  where: Type;
  whereUnique: Type;
  create: Type;
  createMany: Type;
  update: Type;
  select: Type;
  include: Type;
  orderBy: Type;
  selectNested: Type;
  includeNested: Type;
  uncheckedCreate: Type;
  uncheckedUpdate: Type;
}

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
 * Builds all schemas for a model using two-phase approach:
 * 1. Build core schemas first (where, create, update, etc.)
 * 2. Build args schemas using the core schemas (avoids rebuilding)
 */
export const buildModelSchemas = <TFields extends FieldRecord>(
  model: Model<any>
): TypedModelSchemas<TFields> => {
  // Phase 1: Build core schemas
  const core: CoreSchemas = {
    where: buildWhereSchema(model),
    whereUnique: buildWhereUniqueSchema(model),
    create: buildCreateSchema(model),
    createMany: buildCreateManySchema(model),
    update: buildUpdateSchema(model),
    select: buildSelectSchema(model),
    include: buildIncludeSchema(model),
    orderBy: buildOrderBySchema(model),
    selectNested: buildSelectNestedSchema(model),
    includeNested: buildIncludeNestedSchema(model),
    uncheckedCreate: buildUncheckedCreateSchema(model),
    uncheckedUpdate: buildUncheckedUpdateSchema(model),
  };

  // Phase 2: Build args schemas using core schemas (no rebuilding)
  return {
    ...core,

    // Query operation args (some need model for field-specific schemas)
    findMany: buildFindManyArgsSchema(model, core),
    findFirst: buildFindFirstArgsSchema(model, core),
    findUnique: buildFindUniqueArgsSchema(core),
    count: buildCountArgsSchema(model, core),
    exist: buildExistArgsSchema(core),
    aggregate: buildAggregateArgsSchema(model, core),
    groupBy: buildGroupByArgsSchema(model, core),

    // Mutation operation args (all use only core schemas)
    createArgs: buildCreateArgsSchema(core),
    updateArgs: buildUpdateArgsSchema(core),
    updateManyArgs: buildUpdateManyArgsSchema(core),
    deleteArgs: buildDeleteArgsSchema(core),
    deleteManyArgs: buildDeleteManyArgsSchema(core),
    upsertArgs: buildUpsertArgsSchema(core),
  };
};

// Legacy export
export type ModelSchemas = TypedModelSchemas<any>;
