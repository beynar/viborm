import type {
  VibSchema,
  ScalarOptions,
  ComputeInput,
  ComputeOutput,
} from "../types";
import { buildSchema, ok } from "../helpers";

// =============================================================================
// Point Schema ({ x: number, y: number })
// =============================================================================

/**
 * Point type with x and y coordinates.
 */
export interface Point {
  x: number;
  y: number;
}

export interface BasePointSchema<
  Opts extends ScalarOptions<Point, any> | undefined = undefined
> extends VibSchema<ComputeInput<Point, Opts>, ComputeOutput<Point, Opts>> {}

export interface PointSchema<TInput = Point, TOutput = Point>
  extends VibSchema<TInput, TOutput> {
  readonly type: "point";
}

// Pre-computed errors for fast path
const NOT_OBJECT_ERROR = Object.freeze({
  issues: Object.freeze([Object.freeze({ message: "Expected point object" })]),
});
const MISSING_XY_ERROR = Object.freeze({
  issues: Object.freeze([
    Object.freeze({ message: "Expected point with x and y properties" }),
  ]),
});
const INVALID_X_ERROR = Object.freeze({
  issues: Object.freeze([
    Object.freeze({ message: "Expected x to be a number" }),
  ]),
});
const INVALID_Y_ERROR = Object.freeze({
  issues: Object.freeze([
    Object.freeze({ message: "Expected y to be a number" }),
  ]),
});

/**
 * Validate that a value is a point with x and y coordinates.
 */
export function validatePoint(value: unknown) {
  if (typeof value !== "object" || value === null) return NOT_OBJECT_ERROR;

  const obj = value as Record<string, unknown>;
  if (!("x" in obj) || !("y" in obj)) return MISSING_XY_ERROR;
  if (typeof obj.x !== "number" || Number.isNaN(obj.x)) return INVALID_X_ERROR;
  if (typeof obj.y !== "number" || Number.isNaN(obj.y)) return INVALID_Y_ERROR;

  return ok({ x: obj.x, y: obj.y } as Point);
}

/**
 * Create a point schema for { x, y } coordinates.
 *
 * @example
 * const location = v.point();
 * const optionalPoint = v.point({ optional: true });
 * const pointArray = v.point({ array: true });
 */
export function point<
  const Opts extends ScalarOptions<Point, any> | undefined = undefined
>(
  options?: Opts
): PointSchema<ComputeInput<Point, Opts>, ComputeOutput<Point, Opts>> {
  return buildSchema("point", validatePoint, options) as PointSchema<
    ComputeInput<Point, Opts>,
    ComputeOutput<Point, Opts>
  >;
}
