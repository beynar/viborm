// Relation Select & Include Schemas

import {
  lazy,
  object,
  optional,
  boolean,
  union,
  partial,
  number,
  string,
  transform,
  pipe,
} from "valibot";
import type { RelationState } from "../relation";
import { type AnyRelationSchema } from "./helpers";
import { ModelState } from "@schema/model";

// =============================================================================
// SELECT SCHEMAS
// =============================================================================

const buildSelectionFromState = <S extends RelationState>(relationState: S) => {
  const state = relationState.getter()["~"].state as ModelState;
  let select = {};
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
  (value: boolean) => {
    if (value) {
      const select = buildSelectionFromState(relationState);
      return {
        select,
      };
    } else {
      return {
        select: false,
      };
    }
  };

const includeToField =
  <S extends RelationState>(relationState: S) =>
  <V extends Record<string, any>>(value: V) => {
    const hasSelect = "select" in value && value.select !== false;
    const hasInclude = "include" in value && value.include !== false;

    if (hasSelect) {
      return value;
    }
    if (hasInclude) {
      let select = buildSelectionFromState(relationState);
      return {
        ...value,
        select,
      };
    }

    if (!hasSelect && !hasInclude) {
      const select = buildSelectionFromState(relationState);
      return {
        ...value,
        select,
      };
    }
  };
/**
 * To-one select: true or nested { select }
 */
export const toOneSelectFactory = <S extends RelationState>(
  state: S
): AnyRelationSchema => {
  return union([
    pipe(boolean(), transform(booleanToField(state))),
    partial(
      object({
        select: optional(lazy(() => state.getter()["~"].schemas?.select)),
      })
    ),
  ]);
};

/**
 * To-many select: true or nested { where, orderBy, take, skip, select }
 */
export const toManySelectFactory = <S extends RelationState>(
  state: S
): AnyRelationSchema => {
  return union([
    pipe(boolean(), transform(booleanToField(state))),
    partial(
      object({
        where: optional(lazy(() => state.getter()["~"].schemas?.where)),
        orderBy: optional(lazy(() => state.getter()["~"].schemas?.orderBy)),
        take: optional(number()),
        skip: optional(number()),
        select: optional(lazy(() => state.getter()["~"].schemas?.select)),
      })
    ),
  ]);
};

// =============================================================================
// INCLUDE SCHEMAS
// =============================================================================

/**
 * To-one include: true or nested { select, include }
 */
export const toOneIncludeFactory = <S extends RelationState>(
  state: S
): AnyRelationSchema => {
  return union([
    pipe(boolean(), transform(booleanToField(state))),
    pipe(
      partial(
        object({
          select: optional(lazy(() => state.getter()["~"].schemas?.select)),
          include: optional(lazy(() => state.getter()["~"].schemas?.include)),
        })
      ),
      transform(includeToField(state))
    ),
  ]);
};

/**
 * To-many include: true or nested { where, orderBy, take, skip, cursor, select, include }
 */
export const toManyIncludeFactory = <S extends RelationState>(
  state: S
): AnyRelationSchema => {
  return union([
    pipe(boolean(), transform(booleanToField(state))),
    pipe(
      partial(
        object({
          where: optional(lazy(() => state.getter()["~"].schemas?.where)),
          orderBy: optional(lazy(() => state.getter()["~"].schemas?.orderBy)),
          take: optional(number()),
          skip: optional(number()),
          cursor: optional(string()),
          select: optional(lazy(() => state.getter()["~"].schemas?.select)),
          include: optional(lazy(() => state.getter()["~"].schemas?.include)),
        })
      ),
      transform(includeToField(state))
    ),
  ]);
};
