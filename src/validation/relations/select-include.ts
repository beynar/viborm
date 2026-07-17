// Relation Select & Include Schemas

import type { ModelState } from "@schema/model";
import type { RelationState } from "@schema/relation/types";
import { rejectSelectInclude } from "../model/args/select-include-exclusivity";
import { createSchema, fail, ok } from "../primitives/helpers";
import v, { type V } from "../primitives/v";
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

/**
 * Nested to-many `take`: non-negative numbers only.
 *
 * Prisma's negative-take ("last N") semantics are only implemented for
 * top-level queries (reverse order + reverse results). The nested include
 * builder would pass a negative value straight to LIMIT — a runtime error on
 * Postgres and silently ALL rows on SQLite — so reject it at validation.
 * Nested `cursor` is rejected the same way, by omission: strict objects fail
 * on unknown keys.
 */
type NestedTakeSchema = V.Schema<number, number>;
const nestedTake: NestedTakeSchema = createSchema("number", (value) => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fail("Expected finite number");
  }
  if (value < 0) {
    return fail(
      "Negative 'take' is not supported in nested relation queries. " +
        "Use a positive take with the opposite orderBy direction instead."
    );
  }
  return ok(value);
});

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
 * To-many include: true or nested { where, orderBy, take, skip, select, include }
 * `select` and `include` are mutually exclusive on the same node (Prisma parity)
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
        take: NestedTakeSchema;
        skip: V.Number;
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
          take: nestedTake,
          skip: v.number(),
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
