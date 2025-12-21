// Relation Create Schemas

import {
  object,
  optional,
  partial,
} from "valibot";
import type { RelationState } from "../relation";
import {
  type AnyRelationSchema,
  getTargetCreateSchema,
  getTargetWhereUniqueSchema,
  singleOrArray,
} from "./helpers";

// =============================================================================
// CREATE SCHEMAS
// =============================================================================

/**
 * To-one create: { create?, connect?, connectOrCreate? }
 */
export const toOneCreateFactory = <S extends RelationState>(
  state: S
): AnyRelationSchema => {
  const createSchema = getTargetCreateSchema(state);
  const whereUniqueSchema = getTargetWhereUniqueSchema(state);

  return partial(
    object({
      create: optional(createSchema),
      connect: optional(whereUniqueSchema),
      connectOrCreate: optional(
        object({
          where: whereUniqueSchema,
          create: createSchema,
        })
      ),
    })
  );
};

/**
 * To-many create: { create?, connect?, connectOrCreate? }
 * All accept single or array, normalized to array
 */
export const toManyCreateFactory = <S extends RelationState>(
  state: S
): AnyRelationSchema => {
  const createSchema = getTargetCreateSchema(state);
  const whereUniqueSchema = getTargetWhereUniqueSchema(state);

  const connectOrCreateSchema = object({
    where: whereUniqueSchema,
    create: createSchema,
  });

  return partial(
    object({
      create: optional(singleOrArray(createSchema)),
      connect: optional(singleOrArray(whereUniqueSchema)),
      connectOrCreate: optional(singleOrArray(connectOrCreateSchema)),
    })
  );
};

