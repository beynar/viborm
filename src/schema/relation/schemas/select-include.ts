// Relation Select & Include Schemas
import type { RelationState } from "../relation";
import {
  getTargetSelectSchema,
  getTargetIncludeSchema,
  getTargetWhereSchema,
  getTargetOrderBySchema,
} from "./helpers";
import { ModelState } from "@schema/model";
import v from "../../../validation";

// =============================================================================
// TRANSFORM HELPERS
// =============================================================================

const buildSelectionFromState = <S extends RelationState>(
  relationState: S
): Record<string, true> => {
  const state = relationState.getter()["~"].state as ModelState;
  const select: Record<string, true> = {};
  const omits = new Set<string>(Object.keys(state.omit || {}));
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

/**
 * To-one select: true or nested { select }
 */
export const toOneSelectFactory = <S extends RelationState>(state: S) => {
  return v.union([
    v.coerce(v.boolean(), booleanToField(state)),
    v.object({
      select: getTargetSelectSchema(state),
    }),
  ]);
};

/**
 * To-many select: true or nested { where, orderBy, take, skip, select }
 */
export const toManySelectFactory = <S extends RelationState>(state: S) => {
  return v.union([
    v.coerce(v.boolean(), booleanToField(state)),
    v.object({
      where: getTargetWhereSchema(state),
      orderBy: getTargetOrderBySchema(state),
      take: v.number(),
      skip: v.number(),
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
export const toOneIncludeFactory = <S extends RelationState>(state: S) => {
  return v.union([
    v.coerce(v.boolean(), booleanToField(state)),
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
export const toManyIncludeFactory = <S extends RelationState>(state: S) => {
  return v.union([
    v.coerce(v.boolean(), booleanToField(state)),
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
