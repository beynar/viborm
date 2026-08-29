import type {
  ComputeInput,
  ComputeOutput,
  ScalarOptions,
  VibSchema,
} from "../types";
import { type GeoPoint, validateGeoPoint } from "./geo-point-codec";
import { buildSchema } from "./helpers";

// =============================================================================
// GeoPoint Schema ({ longitude: number, latitude: number })
// =============================================================================

export interface BasePointSchema<
  Opts extends ScalarOptions<GeoPoint, any> | undefined = undefined,
> extends VibSchema<
    ComputeInput<GeoPoint, Opts>,
    ComputeOutput<GeoPoint, Opts>
  > {}

export interface PointSchema<TInput = GeoPoint, TOutput = GeoPoint>
  extends VibSchema<TInput, TOutput> {
  readonly type: "point";
}

/**
 * Create a point schema for EPSG:4326 longitude/latitude coordinates.
 *
 * @example
 * const location = v.point();
 * const optionalPoint = v.point({ optional: true });
 * const pointArray = v.point({ array: true });
 */
export function point<
  const Opts extends ScalarOptions<GeoPoint, any> | undefined = undefined,
>(
  options?: Opts
): PointSchema<ComputeInput<GeoPoint, Opts>, ComputeOutput<GeoPoint, Opts>> {
  return buildSchema("point", validateGeoPoint, options) as PointSchema<
    ComputeInput<GeoPoint, Opts>,
    ComputeOutput<GeoPoint, Opts>
  >;
}

export { type GeoPoint, validateGeoPoint } from "./geo-point-codec";
