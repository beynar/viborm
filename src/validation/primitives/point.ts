import type {
  ComputeInput,
  ComputeOutput,
  ScalarOptions,
  VibSchema,
} from "../types";
import { isNumber, isRecord } from "../value-guards";
import { buildSchema, ok } from "./helpers";

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
  Opts extends ScalarOptions<Point, any> | undefined = undefined,
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
  if (!isRecord(value)) return NOT_OBJECT_ERROR;
  if (!("x" in value && "y" in value)) return MISSING_XY_ERROR;
  if (!isNumber(value.x) || Number.isNaN(value.x)) return INVALID_X_ERROR;
  if (!isNumber(value.y) || Number.isNaN(value.y)) return INVALID_Y_ERROR;

  return ok({ x: value.x, y: value.y });
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
  const Opts extends ScalarOptions<Point, any> | undefined = undefined,
>(
  options?: Opts
): PointSchema<ComputeInput<Point, Opts>, ComputeOutput<Point, Opts>> {
  return buildSchema("point", validatePoint, options) as PointSchema<
    ComputeInput<Point, Opts>,
    ComputeOutput<Point, Opts>
  >;
}
