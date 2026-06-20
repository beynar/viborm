// Relation Select & Include Schemas

import type { ModelState } from "@schema/model";
import type { RelationState } from "@schema/relation/types";
import v, { type V } from "@validation";
import type { GetTargetSchemas, SchemaGetter } from "./helpers";

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
export type ToOneSelectSchema<S extends RelationState> = V.Union<
  readonly [
    BooleanToSelect,
    V.Object<{ select: () => GetTargetSchemas<S>["core"]["select"] }>,
  ]
>;
export const toOneSelectFactory = <
  S extends RelationState,
  T extends SchemaGetter<S>,
>(
  state: S,
  targetSchemas: T
): ToOneSelectSchema<S> => {
  return v.union([
    booleanToSelect(state),
    v.object({
      select: () => targetSchemas().core.select,
    }),
  ]);
};

/**
 * To-many select: true or nested { where, orderBy, take, skip, select }
 */
export type ToManySelectSchema<S extends RelationState> = V.Union<
  readonly [
    BooleanToSelect,
    V.Object<{
      where: () => GetTargetSchemas<S>["core"]["where"];
      orderBy: () => GetTargetSchemas<S>["core"]["orderBy"];
      take: V.Number;
      skip: V.Number;
      cursor: V.String;
      select: () => GetTargetSchemas<S>["core"]["select"];
    }>,
  ]
>;
export const toManySelectFactory = <
  S extends RelationState,
  T extends SchemaGetter<S>,
>(
  state: S,
  targetSchemas: T
): ToManySelectSchema<S> => {
  return v.union([
    booleanToSelect(state),
    v.object({
      where: () => targetSchemas().core.where,
      orderBy: () => targetSchemas().core.orderBy,
      take: v.number(),
      skip: v.number(),
      cursor: v.string(),
      select: () => targetSchemas().core.select,
    }),
  ]);
};

// =============================================================================
// INCLUDE FACTORY IMPLEMENTATIONS
// =============================================================================

/**
 * To-one include: true or nested { select, include }
 */

export type ToOneIncludeSchema<S extends RelationState> = V.Union<
  readonly [
    BooleanToSelect,
    IncludeToField<
      V.Object<{
        select: () => GetTargetSchemas<S>["core"]["select"];
        include: () => GetTargetSchemas<S>["core"]["include"];
      }>
    >,
  ]
>;
export const toOneIncludeFactory = <
  S extends RelationState,
  T extends SchemaGetter<S>,
>(
  state: S,
  targetSchemas: T
): ToOneIncludeSchema<S> => {
  return v.union([
    booleanToSelect(state),
    v.coerce(
      v.object({
        select: () => targetSchemas().core.select,
        include: () => targetSchemas().core.include,
      }),
      includeToField(state)
    ),
  ]);
};

/**
 * To-many include: true or nested { where, orderBy, take, skip, cursor, select, include }
 */
export type ToManyIncludeSchema<S extends RelationState> = V.Union<
  readonly [
    BooleanToSelect,
    IncludeToField<
      V.Object<{
        where: () => GetTargetSchemas<S>["core"]["where"];
        orderBy: () => GetTargetSchemas<S>["core"]["orderBy"];
        take: V.Number;
        skip: V.Number;
        cursor: V.String;
        select: () => GetTargetSchemas<S>["core"]["select"];
        include: () => GetTargetSchemas<S>["core"]["include"];
      }>
    >,
  ]
>;
export const toManyIncludeFactory = <
  S extends RelationState,
  T extends SchemaGetter<S>,
>(
  state: S,
  targetSchemas: T
): ToManyIncludeSchema<S> => {
  return v.union([
    booleanToSelect(state),
    v.coerce(
      v.object({
        where: () => targetSchemas().core.where,
        orderBy: () => targetSchemas().core.orderBy,
        take: v.number(),
        skip: v.number(),
        cursor: v.string(),
        select: () => targetSchemas().core.select,
        include: () => targetSchemas().core.include,
      }),
      includeToField(state)
    ),
  ]);
};
