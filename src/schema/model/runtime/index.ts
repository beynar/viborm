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
 * Runtime schemas for a model.
 * Uses Type (without generic) to avoid deep ArkType type inference.
 * The actual types are enforced at the function return level.
 */
export interface TypedModelSchemas<TFields extends FieldRecord> {
  // Core input types
  where: Type;
  whereUnique: Type;
  create: Type;
  createMany: Type;
  update: Type;
  select: Type;
  include: Type;
  orderBy: Type;

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

  // Unchecked types (FK-based)
  uncheckedCreate: Type;
  uncheckedUpdate: Type;

  // Nested select/include types
  selectNested: Type;
  includeNested: Type;
}

// =============================================================================
// BUILD MODEL SCHEMAS
// =============================================================================

/**
 * Builds all schemas for a model
 */
export const buildModelSchemas = <TFields extends FieldRecord>(
  model: Model<any>
): TypedModelSchemas<TFields> => ({
  // Core input types
  where: buildWhereSchema(model),
  whereUnique: buildWhereUniqueSchema(model),
  create: buildCreateSchema(model),
  createMany: buildCreateManySchema(model),
  update: buildUpdateSchema(model),
  select: buildSelectSchema(model),
  include: buildIncludeSchema(model),
  orderBy: buildOrderBySchema(model),

  // Query operation args types
  findMany: buildFindManyArgsSchema(model),
  findFirst: buildFindFirstArgsSchema(model),
  findUnique: buildFindUniqueArgsSchema(model),
  count: buildCountArgsSchema(model),
  exist: buildExistArgsSchema(model),
  aggregate: buildAggregateArgsSchema(model),
  groupBy: buildGroupByArgsSchema(model),

  // Mutation operation args types
  createArgs: buildCreateArgsSchema(model),
  updateArgs: buildUpdateArgsSchema(model),
  updateManyArgs: buildUpdateManyArgsSchema(model),
  deleteArgs: buildDeleteArgsSchema(model),
  deleteManyArgs: buildDeleteManyArgsSchema(model),
  upsertArgs: buildUpsertArgsSchema(model),

  // Unchecked types (FK-based)
  uncheckedCreate: buildUncheckedCreateSchema(model),
  uncheckedUpdate: buildUncheckedUpdateSchema(model),

  // Nested select/include types
  selectNested: buildSelectNestedSchema(model),
  includeNested: buildIncludeNestedSchema(model),
});

// Legacy export
export type ModelSchemas = TypedModelSchemas<any>;
