// Relation Select & Include Schemas

import type { ModelState } from "@schema/model";
import v, { type V } from "@validation";
import type { RelationState } from "../types";
import {
  getTargetIncludeSchema,
  getTargetOrderBySchema,
  getTargetSelectSchema,
  getTargetWhereSchema,
  type InferTargetSchema,
} from "./helpers";

// =============================================================================
// TRANSFORM HELPERS
// =============================================================================

const buildSelectionFromState = <S extends RelationState>(
  relationState: S
): Record<string, true> => {
  const state = relationState.getter()["~"].state as ModelState;
  const select: Record<string, true> = {};
  const omits = new Set<string>(Object.keys(state.omit || {}));
  for (const field of Object.keys(state.scalars)) {
    if (!omits.has(field)) {
      select[field] = true;
    }
  }
  return select;
};

type IncludeToField<Schema extends V.Object<any>> = V.Coerce<
  Schema,
  Schema[" vibInferred"]["1"] & { select?: Record<string, true> }
>;

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

type BooleanToSelect = V.Coerce<
  V.Boolean,
  { select: Record<string, true> | false }
>;

const booleanToSelect = <S extends RelationState>(
  relationState: S
): BooleanToSelect =>
  v.coerce(
    v.boolean(),
    (value: boolean): { select: Record<string, true> | false } => {
      if (value) {
        return { select: buildSelectionFromState(relationState) };
      }
      return { select: false };
    }
  );

/**
 * To-one select: true or nested { select }
 */
export type ToOneSelect<S extends RelationState> = V.Union<
  readonly [
    BooleanToSelect,
    V.Object<{ select: () => InferTargetSchema<S, "select"> }>,
  ]
>;
export const toOneSelectFactory = <S extends RelationState>(
  state: S
): ToOneSelect<S> => {
  return v.union([
    booleanToSelect(state),
    v.object({
      select: getTargetSelectSchema(state),
    }),
  ]);
};

/**
 * To-many select: true or nested { where, orderBy, take, skip, select }
 */
export type ToManySelect<S extends RelationState> = V.Union<
  readonly [
    BooleanToSelect,
    V.Object<{
      where: () => InferTargetSchema<S, "where">;
      orderBy: () => InferTargetSchema<S, "orderBy">;
      take: V.Number;
      skip: V.Number;
      cursor: V.String;
      select: () => InferTargetSchema<S, "select">;
    }>,
  ]
>;
export const toManySelectFactory = <S extends RelationState>(
  state: S
): ToManySelect<S> => {
  return v.union([
    booleanToSelect(state),
    v.object({
      where: getTargetWhereSchema(state),
      orderBy: getTargetOrderBySchema(state),
      take: v.number(),
      skip: v.number(),
      cursor: v.string(),
      select: getTargetSelectSchema(state),
    }),
  ]);
};

// =============================================================================
// INCLUDE FACTORY IMPLEMENTATIONS
// =============================================================================

/**
 * To-one include: true or nested { select, include }
 */

type ToOneInclude<S extends RelationState> = V.Union<
  readonly [
    BooleanToSelect,
    IncludeToField<
      V.Object<{
        select: () => InferTargetSchema<S, "select">;
        include: () => InferTargetSchema<S, "include">;
      }>
    >,
  ]
>;
export const toOneIncludeFactory = <S extends RelationState>(
  state: S
): ToOneInclude<S> => {
  return v.union([
    booleanToSelect(state),
    v.coerce(
      v.object({
        select: getTargetSelectSchema(state),
        include: getTargetIncludeSchema(state),
      }),
      includeToField(state)
    ),
  ]);
};

/**
 * To-many include: true or nested { where, orderBy, take, skip, cursor, select, include }
 */
type ToManyInclude<S extends RelationState> = V.Union<
  readonly [
    BooleanToSelect,
    IncludeToField<
      V.Object<{
        where: () => InferTargetSchema<S, "where">;
        orderBy: () => InferTargetSchema<S, "orderBy">;
        take: V.Number;
        skip: V.Number;
        cursor: V.String;
        select: () => InferTargetSchema<S, "select">;
        include: () => InferTargetSchema<S, "include">;
      }>
    >,
  ]
>;
export const toManyIncludeFactory = <S extends RelationState>(
  state: S
): ToManyInclude<S> => {
  return v.union([
    booleanToSelect(state),
    v.coerce(
      v.object({
        where: getTargetWhereSchema(state),
        orderBy: getTargetOrderBySchema(state),
        take: v.number(),
        skip: v.number(),
        cursor: v.string(),
        select: getTargetSelectSchema(state),
        include: getTargetIncludeSchema(state),
      }),
      includeToField(state)
    ),
  ]);
};
