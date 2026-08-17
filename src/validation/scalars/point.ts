import type { ScalarState } from "@schema/scalars/common";
import { lazyScalarSchemas } from "../lazy";
import v, { type V } from "../primitives/v";
import {
  buildNegatableFilterSchema,
  type NegatableFilterSchema,
} from "./negatable-filter";

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

type PointFilterSchema<S extends V.Schema> = NegatableFilterSchema<
  S,
  PointFilterBase<S>
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
  return buildNegatableFilterSchema<S, PointFilterBase<S>>(filter, schema);
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
  return lazyScalarSchemas<PointSchemas<F>>({
    base: state.base,
    create: () => v.point(state),
    update: () => buildPointUpdateSchema<F["base"]>(state.base),
    filter: () => buildPointFilterSchema<F["base"]>(state.base),
  });
};
