import type { FieldState } from "@schema/fields/common";
import v, { type V } from "@validation";

// =============================================================================
// FILTER TYPES
// =============================================================================

type PointFilterBase<S extends V.Schema> = {
  equals: S;
  intersects: S;
  contains: S;
  within: S;
  crosses: S;
  overlaps: S;
  touches: S;
  covers: S;
  dWithin: V.Object<{
    geometry: S;
    distance: V.Number;
  }>;
};

type PointFilterSchema<S extends V.Schema> = V.Union<
  readonly [
    V.ShorthandFilter<S>,
    V.Object<
      PointFilterBase<S> & {
        not: V.Union<
          readonly [V.ShorthandFilter<S>, V.Object<PointFilterBase<S>>]
        >;
      }
    >,
  ]
>;

// =============================================================================
// UPDATE TYPES
// =============================================================================

type PointUpdateSchema<S extends V.Schema> = V.Union<
  readonly [V.ShorthandUpdate<S>, V.Object<{ set: S }, { partial: false }>]
>;

// =============================================================================
// SCHEMA BUILDERS
// =============================================================================

const buildPointFilterSchema = <S extends V.Schema>(
  schema: S
): PointFilterSchema<S> => {
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
    v.shorthandFilter(schema),
    filter.extend({
      not: v.union([v.shorthandFilter(schema), filter]),
    }),
  ]);
};

const buildPointUpdateSchema = <S extends V.Schema>(
  schema: S
): PointUpdateSchema<S> =>
  v.union([
    v.shorthandUpdate(schema),
    v.object(
      {
        set: schema,
      },
      { partial: false }
    ),
  ]);

// =============================================================================
// POINT SCHEMA BUILDER
// =============================================================================

export interface PointSchemas<F extends FieldState<"point">> {
  base: F["base"];
  create: V.Point<F>;
  update: PointUpdateSchema<F["base"]>;
  filter: PointFilterSchema<F["base"]>;
}

export const buildPointSchema = <F extends FieldState<"point">>(
  state: F
): PointSchemas<F> => {
  return {
    base: state.base as F["base"],
    create: v.point(state),
    update: buildPointUpdateSchema(state.base),
    filter: buildPointFilterSchema(state.base),
  } as PointSchemas<F>;
};
