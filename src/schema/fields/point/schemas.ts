import { FieldState, shorthandFilter, shorthandUpdate } from "../common";
import v, {
  BasePointSchema,
  InferInput,
  InferOutput,
  VibSchema,
} from "../../../validation";

// =============================================================================
// BASE TYPES
// =============================================================================

export const pointBase = v.point();
export const pointNullable = v.point({ nullable: true });

// =============================================================================
// FILTER SCHEMAS (PostGIS spatial operations)
// =============================================================================

const buildPointFilterSchema = <S extends VibSchema>(schema: S) => {
  const filter = v.object({
    equals: schema,
    intersects: schema,
    contains: schema,
    within: schema,
    crosses: schema,
    overlaps: schema,
    touches: schema,
    covers: schema,
    dWithin: v.object({
      geometry: schema,
      distance: v.number(),
    }),
  });
  return v.union([
    shorthandFilter(schema),
    filter.extend({
      not: v.union([shorthandFilter(schema), filter]),
    }),
  ]);
};

const buildPointUpdateSchema = <S extends VibSchema>(schema: S) =>
  v.union([
    shorthandUpdate(schema),
    v.object(
      {
        set: schema,
      },
      { partial: false }
    ),
  ]);

export const buildPointSchema = <F extends FieldState<"point">>(state: F) => {
  return {
    base: state.base,
    create: v.point(state),
    update: buildPointUpdateSchema(state.base),
    filter: buildPointFilterSchema(state.base),
  } as PointSchemas<F>;
};

type PointSchemas<F extends FieldState<"point">> = {
  base: F["base"];
  create: BasePointSchema<F>;
  update: ReturnType<typeof buildPointUpdateSchema<F["base"]>>;
  filter: ReturnType<typeof buildPointFilterSchema<F["base"]>>;
};

export type InferPointInput<
  F extends FieldState<"point">,
  Type extends "create" | "update" | "filter" | "base"
> = InferInput<PointSchemas<F>[Type]>;

export type InferPointOutput<
  F extends FieldState<"point">,
  Type extends "create" | "update" | "filter" | "base"
> = InferOutput<PointSchemas<F>[Type]>;

