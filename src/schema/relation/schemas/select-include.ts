// Relation Select & Include Schemas

import {
  object,
  optional,
  boolean,
  union,
  partial,
  number,
  string,
  transform,
  pipe,
  type ObjectSchema,
  type OptionalSchema,
  type UnionSchema,
  type SchemaWithPipe,
  type TransformAction,
  type NumberSchema,
  type StringSchema,
} from "valibot";
import type { RelationState } from "../relation";
import {
  type InferTargetSchema,
  type BooleanToSelectPipe,
  getTargetSelectSchema,
  getTargetIncludeSchema,
  getTargetWhereSchema,
  getTargetOrderBySchema,
} from "./helpers";
import { ModelState } from "@schema/model";

// =============================================================================
// TRANSFORM HELPERS
// =============================================================================

const buildSelectionFromState = <S extends RelationState>(
  relationState: S
): Record<string, true> => {
  const state = relationState.getter()["~"].state as ModelState;
  const select: Record<string, true> = {};
  const omits = new Set<string>(state.omit);
  Object.keys(state.scalars).forEach((field) => {
    if (!omits.has(field)) {
      select[field] = true;
    }
  });
  return select;
};

const booleanToField =
  <S extends RelationState>(relationState: S) =>
  (value: boolean): { select: Record<string, true> | false } => {
    if (value) {
      return { select: buildSelectionFromState(relationState) };
    }
    return { select: false };
  };

const includeToField =
  <S extends RelationState>(relationState: S) =>
  <V extends Record<string, any>>(
    value: V
  ): V & { select?: Record<string, true> } => {
    if ("select" in value && value.select !== false) {
      return value;
    }
    return {
      ...value,
      select: buildSelectionFromState(relationState),
    };
  };

// =============================================================================
// SELECT SCHEMA TYPES (exported for consumer use)
// =============================================================================

/** To-one select object schema */
export type ToOneSelectObjectSchema<S extends RelationState> = ObjectSchema<
  {
    select: OptionalSchema<InferTargetSchema<S, "select">, undefined>;
  },
  undefined
>;

/** To-one select schema: boolean or nested select object */
export type ToOneSelectSchema<S extends RelationState> = UnionSchema<
  [BooleanToSelectPipe, ToOneSelectObjectSchema<S>],
  undefined
>;

/** To-many select object schema with filtering and pagination */
export type ToManySelectObjectSchema<S extends RelationState> = ObjectSchema<
  {
    where: OptionalSchema<InferTargetSchema<S, "where">, undefined>;
    orderBy: OptionalSchema<InferTargetSchema<S, "orderBy">, undefined>;
    take: OptionalSchema<NumberSchema<undefined>, undefined>;
    skip: OptionalSchema<NumberSchema<undefined>, undefined>;
    select: OptionalSchema<InferTargetSchema<S, "select">, undefined>;
  },
  undefined
>;

/** To-many select schema: boolean or nested select object with options */
export type ToManySelectSchema<S extends RelationState> = UnionSchema<
  [BooleanToSelectPipe, ToManySelectObjectSchema<S>],
  undefined
>;

// =============================================================================
// INCLUDE SCHEMA TYPES (exported for consumer use)
// =============================================================================

/** To-one include object schema */
export type ToOneIncludeObjectSchema<S extends RelationState> = ObjectSchema<
  {
    select: OptionalSchema<InferTargetSchema<S, "select">, undefined>;
    include: OptionalSchema<InferTargetSchema<S, "include">, undefined>;
  },
  undefined
>;

/** Include object with transform pipe */
export type IncludeObjectWithPipe<S extends RelationState> = SchemaWithPipe<
  readonly [ToOneIncludeObjectSchema<S>, TransformAction<any, any>]
>;

/** To-one include schema: boolean or nested include object */
export type ToOneIncludeSchema<S extends RelationState> = UnionSchema<
  [BooleanToSelectPipe, IncludeObjectWithPipe<S>],
  undefined
>;

/** To-many include object schema with full pagination support */
export type ToManyIncludeObjectSchema<S extends RelationState> = ObjectSchema<
  {
    where: OptionalSchema<InferTargetSchema<S, "where">, undefined>;
    orderBy: OptionalSchema<InferTargetSchema<S, "orderBy">, undefined>;
    take: OptionalSchema<NumberSchema<undefined>, undefined>;
    skip: OptionalSchema<NumberSchema<undefined>, undefined>;
    cursor: OptionalSchema<StringSchema<undefined>, undefined>;
    select: OptionalSchema<InferTargetSchema<S, "select">, undefined>;
    include: OptionalSchema<InferTargetSchema<S, "include">, undefined>;
  },
  undefined
>;

/** To-many include object with transform pipe */
export type ToManyIncludeObjectWithPipe<S extends RelationState> =
  SchemaWithPipe<
    readonly [ToManyIncludeObjectSchema<S>, TransformAction<any, any>]
  >;

/** To-many include schema: boolean or nested include object with options */
export type ToManyIncludeSchema<S extends RelationState> = UnionSchema<
  [BooleanToSelectPipe, ToManyIncludeObjectWithPipe<S>],
  undefined
>;

// =============================================================================
// SELECT FACTORY IMPLEMENTATIONS
// =============================================================================

/**
 * To-one select: true or nested { select }
 */
export const toOneSelectFactory = <S extends RelationState>(state: S) => {
  const selectSchema = getTargetSelectSchema(state);

  return union([
    pipe(boolean(), transform(booleanToField(state))),
    object({
      select: optional(selectSchema),
    }),
  ]);
};

/**
 * To-many select: true or nested { where, orderBy, take, skip, select }
 */
export const toManySelectFactory = <S extends RelationState>(state: S) => {
  const whereSchema = getTargetWhereSchema(state);
  const orderBySchema = getTargetOrderBySchema(state);
  const selectSchema = getTargetSelectSchema(state);

  return union([
    pipe(boolean(), transform(booleanToField(state))),
    partial(
      object({
        where: optional(whereSchema),
        orderBy: optional(orderBySchema),
        take: optional(number()),
        skip: optional(number()),
        select: optional(selectSchema),
      })
    ),
  ]);
};

// =============================================================================
// INCLUDE FACTORY IMPLEMENTATIONS
// =============================================================================

/**
 * To-one include: true or nested { select, include }
 */
export const toOneIncludeFactory = <S extends RelationState>(state: S) => {
  const selectSchema = getTargetSelectSchema(state);
  const includeSchema = getTargetIncludeSchema(state);

  return union([
    pipe(boolean(), transform(booleanToField(state))),
    pipe(
      partial(
        object({
          select: optional(selectSchema),
          include: optional(includeSchema),
        })
      ),
      transform(includeToField(state))
    ),
  ]);
};

/**
 * To-many include: true or nested { where, orderBy, take, skip, cursor, select, include }
 */
export const toManyIncludeFactory = <S extends RelationState>(state: S) => {
  const whereSchema = getTargetWhereSchema(state);
  const orderBySchema = getTargetOrderBySchema(state);
  const selectSchema = getTargetSelectSchema(state);
  const includeSchema = getTargetIncludeSchema(state);

  return union([
    pipe(boolean(), transform(booleanToField(state))),
    pipe(
      partial(
        object({
          where: optional(whereSchema),
          orderBy: optional(orderBySchema),
          take: optional(number()),
          skip: optional(number()),
          cursor: optional(string()),
          select: optional(selectSchema),
          include: optional(includeSchema),
        })
      ),
      transform(includeToField(state))
    ),
  ]);
};
