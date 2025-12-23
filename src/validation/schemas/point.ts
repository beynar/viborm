import { inferred } from "../inferred";
import type {
  VibSchema,
  ScalarOptions,
  ComputeInput,
  ComputeOutput,
} from "../types";
import { applyOptions, fail, ok, createSchema } from "../helpers";

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

export interface PointSchema<TInput = Point, TOutput = Point>
  extends VibSchema<TInput, TOutput> {
  readonly type: "point";
}

/**
 * Validate that a value is a point with x and y coordinates.
 */
export function validatePoint(value: unknown) {
  if (typeof value !== "object" || value === null) {
    return fail(`Expected point object, received ${typeof value}`);
  }

  const obj = value as Record<string, unknown>;

  if (!("x" in obj) || !("y" in obj)) {
    return fail(`Expected point with x and y properties`);
  }

  if (typeof obj.x !== "number" || Number.isNaN(obj.x)) {
    return fail(`Expected x to be a number, received ${typeof obj.x}`);
  }

  if (typeof obj.y !== "number" || Number.isNaN(obj.y)) {
    return fail(`Expected y to be a number, received ${typeof obj.y}`);
  }

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
  const Opts extends ScalarOptions<Point, any> | undefined = undefined,
>(
  options?: Opts
): PointSchema<ComputeInput<Point, Opts>, ComputeOutput<Point, Opts>> {
  return createSchema("point", (value) =>
    applyOptions(value, validatePoint, options, "point")
  ) as PointSchema<ComputeInput<Point, Opts>, ComputeOutput<Point, Opts>>;
}

