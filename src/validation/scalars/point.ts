import type { ScalarState } from "@schema/scalars/common";
import { lazyScalarSchemas } from "../lazy";
import { geoAreaSchema } from "../primitives/geo-area-codec";
import { createSchema, fail, ok } from "../primitives/helpers";
import { validateNumber } from "../primitives/number";
import v, { type V } from "../primitives/v";
import {
  buildNegatableFilterSchema,
  type NegatableFilterSchema,
} from "./negatable-filter";

// =============================================================================
// FILTER TYPES
// =============================================================================

type PointFilterBase<S extends V.Schema> = {
  equals: S;
  distance: ReturnType<typeof pointDistanceSchema>;
  within: ReturnType<typeof geoAreaSchema>;
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

const meters = createSchema<number, number>("number", (value) => {
  const result = validateNumber(value);
  if (result.issues) return result;
  return result.value < 0
    ? fail("Distance comparisons must use non-negative meters")
    : ok(result.value);
});

const pointDistanceSchema = () =>
  v.object(
    {
      to: v.point(),
      lt: meters,
      lte: meters,
      gt: meters,
      gte: meters,
    },
    {
      atLeast: ["to"],
      requiresOneOf: [["lt", "lte", "gt", "gte"]],
    }
  );

const buildPointFilterSchema = <S extends V.Schema>(
  schema: S
): PointFilterSchema<S> => {
  const filter = v.object({
    equals: schema,
    distance: pointDistanceSchema(),
    within: geoAreaSchema(),
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
