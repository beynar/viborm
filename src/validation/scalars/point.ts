import type { ScalarState } from "@schema/scalars/common";
import v, { type V } from "../primitives/v";

// =============================================================================
// FILTER TYPES
// =============================================================================

// Geospatial operators (intersects/contains/within/crosses/overlaps/
// touches/covers/dWithin) are deliberately absent: the query engine
// rejects them, so the types must not offer them. The PG adapter
// implementations stay reserved for a future opt-in.
type PointFilterBase<S extends V.Schema> = {
  equals: S;
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

export interface PointSchemas<F extends ScalarState<"point">> {
  base: F["base"];
  create: V.Point<F>;
  update: PointUpdateSchema<F["base"]>;
  filter: PointFilterSchema<F["base"]>;
}

export const buildPointSchema = <F extends ScalarState<"point">>(
  state: F
): PointSchemas<F> => {
  return {
    base: state.base as F["base"],
    create: v.point(state),
    update: buildPointUpdateSchema(state.base),
    filter: buildPointFilterSchema(state.base),
  } as PointSchemas<F>;
};
