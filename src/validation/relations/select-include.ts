// Relation Select & Include Schemas

import type { ModelState } from "@schema/model";
import type { StringKeyOf } from "@schema/model/helper";
import type { RelationState } from "@schema/relation/types";
import {
  type PaginationSkipSchema,
  type PaginationTakeSchema,
  paginationSkip,
  paginationTake,
} from "../model/args/pagination";
import { rejectSelectInclude } from "../model/args/select-include-exclusivity";
import v, { type V } from "../primitives/v";
import type { GetTargetSchemas, SchemaGetter, TargetModel } from "./helpers";

// =============================================================================
// TRANSFORM HELPERS
// =============================================================================

const getTargetState = <S extends RelationState>(
  relationState: S
): ModelState => relationState.getter()["~"].state as ModelState;

const buildSelectionFromState = <S extends RelationState>(
  relationState: S
): Record<string, true> => {
  const state = getTargetState(relationState);
  const select: Record<string, true> = {};
  const omits = new Set<string>(Object.keys(state.omit || {}));
  for (const field of Object.keys(state.scalars)) {
    if (!omits.has(field)) {
      select[field] = true;
    }
  }
  return select;
};

/**
 * Nested `distinct`: scalar field names of the RELATED model, deduplicating
 * that relation's ordered rows before `take`/`skip` window them (the same
 * enum-of-scalars schema the top-level findMany args use).
 */
type NestedDistinctSchema<S extends RelationState> = V.Enum<
  StringKeyOf<TargetModel<S>["~"]["state"]["scalars"]>[],
  { array: true }
>;

const nestedDistinct = <S extends RelationState>(
  relationState: S
): NestedDistinctSchema<S> =>
  v.enum(
    Object.keys(getTargetState(relationState).scalars) as StringKeyOf<
      TargetModel<S>["~"]["state"]["scalars"]
    >[],
    { array: true }
  );

type IncludeToField<Schema extends V.Object<any>> = V.Coerce<
  Schema,
  Schema[" vibInferred"]["1"] & { select?: Record<string, true> }
>;

const includeToField =
  <S extends RelationState>(relationState: S) =>
  <V extends Record<string, any>>(
    value: V
  ): V & { select?: Record<string, true> } => {
    if (Object.hasOwn(value, "select") && value.select !== false) {
      return value;
    }
    const select = buildSelectionFromState(relationState);
    if (Object.keys(select).length === 0) return value;
    return {
      ...value,
      select,
    };
  };

type BooleanToSelect = V.Coerce<
  V.Boolean,
  { select?: Record<string, true> } | false
>;

// `false` stays `false` so the query engine omits the relation entirely
// (Prisma parity: include/select `rel: false` must not return the relation)
const booleanToSelect = <S extends RelationState>(
  relationState: S
): BooleanToSelect =>
  v.coerce(
    v.boolean(),
    (value: boolean): { select?: Record<string, true> } | false => {
      if (value) {
        const select = buildSelectionFromState(relationState);
        return Object.keys(select).length > 0 ? { select } : {};
      }
      return false;
    }
  );

// =============================================================================
// INCLUDE FACTORY IMPLEMENTATIONS
// =============================================================================

/**
 * To-one include: true or nested { select, include }
 * `select` and `include` are mutually exclusive on the same node (Prisma parity)
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
      rejectSelectInclude(
        v.object({
          select: () => targetSchemas().core.select,
          include: () => targetSchemas().core.include,
        })
      ),
      includeToField(state)
    ),
  ]);
};

/**
 * To-many include: true or nested
 * { where, orderBy, take, skip, cursor, distinct, select, include }
 * `select` and `include` are mutually exclusive on the same node (Prisma parity)
 *
 * `take`/`skip`/`cursor`/`distinct` are the very schemas the top level uses: a
 * negative `take` is Prisma's "last N" (the relation subquery runs the reversed
 * order with an absolute limit and the parser restores the logical order), a
 * non-integer take or a negative skip is refused with the top-level message,
 * `cursor` is a whereUnique of the RELATED model applied per parent, and
 * `distinct` names scalars of the RELATED model.
 */
export type ToManyIncludeSchema<S extends RelationState> = V.Union<
  readonly [
    BooleanToSelect,
    IncludeToField<
      V.Object<{
        where: () => GetTargetSchemas<S>["core"]["where"];
        orderBy: () => V.Union<
          readonly [
            GetTargetSchemas<S>["core"]["orderBy"],
            V.Array<GetTargetSchemas<S>["core"]["orderBy"]>,
          ]
        >;
        take: PaginationTakeSchema;
        skip: PaginationSkipSchema;
        cursor: () => GetTargetSchemas<S>["core"]["whereUnique"];
        distinct: NestedDistinctSchema<S>;
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
      rejectSelectInclude(
        v.object({
          where: () => targetSchemas().core.where,
          orderBy: () => {
            const orderBySchema = targetSchemas().core.orderBy;
            return v.union([orderBySchema, v.array(orderBySchema)]);
          },
          take: paginationTake(),
          skip: paginationSkip(),
          cursor: () => targetSchemas().core.whereUnique,
          distinct: nestedDistinct(state),
          select: () => targetSchemas().core.select,
          include: () => targetSchemas().core.include,
        })
      ),
      includeToField(state)
    ),
  ]);
};

/**
 * Relation-level args are the same shape in select and include position
 * (Prisma parity: select/include can alternate down the relation tree)
 */
export type ToOneSelectSchema<S extends RelationState> = ToOneIncludeSchema<S>;
export const toOneSelectFactory = toOneIncludeFactory;

export type ToManySelectSchema<S extends RelationState> =
  ToManyIncludeSchema<S>;
export const toManySelectFactory = toManyIncludeFactory;
