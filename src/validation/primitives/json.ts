import type {
  ComputeInput,
  ComputeOutput,
  ScalarOptions,
  VibSchema,
} from "../types";
import { isBoolean, isNumber, isRecord, isString } from "../value-guards";
import { buildSchema, ok } from "./helpers";

// =============================================================================
// JSON Schema
// =============================================================================

/**
 * JSON-compatible value type.
 * Represents any value that can be safely serialized to JSON.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * A JSON value in WRITE position: everything `JsonValue` allows EXCEPT a bare
 * top-level `null`.
 *
 * Once `DbNull` and `JsonNull` exist, a top-level `null` no longer says which
 * of the two nulls it means, so it is not a legal write value — the same line
 * Prisma draws with its own `InputJsonValue`. Nested nulls are untouched:
 * `{ a: null }` is an ordinary document.
 */
export type InputJsonValue = Exclude<JsonValue, null>;

export interface BaseJsonSchema<
  Opts extends ScalarOptions<JsonValue, any> | undefined = undefined,
> extends VibSchema<
    ComputeInput<JsonValue, Opts>,
    ComputeOutput<JsonValue, Opts>
  > {}

export interface JsonSchema<TInput = JsonValue, TOutput = JsonValue>
  extends VibSchema<TInput, TOutput> {
  readonly type: "json";
}

// Pre-computed errors for fast path
const NOT_JSON_ERROR = Object.freeze({
  issues: Object.freeze([
    Object.freeze({ message: "Expected JSON-compatible value" }),
  ]),
});

/**
 * Check if a value is JSON-compatible (can be serialized without loss).
 * Rejects: undefined, functions, symbols, bigint, circular references.
 */
function isJsonValue(value: unknown, seen = new WeakSet<object>()): boolean {
  // Primitives
  if (value === null) return true;
  if (isString(value)) return true;
  if (isNumber(value)) return Number.isFinite(value); // Reject NaN, Infinity
  if (isBoolean(value)) return true;

  // Arrays
  if (Array.isArray(value)) {
    // Check for circular reference
    if (seen.has(value)) return false;
    seen.add(value);
    for (let i = 0; i < value.length; i++) {
      if (!isJsonValue(value[i], seen)) return false;
    }
    return true;
  }

  // Objects
  if (isRecord(value)) {
    // Check for circular reference
    if (seen.has(value)) return false;
    seen.add(value);

    // Must be a plain object (not Date, RegExp, etc.)
    const proto = Object.getPrototypeOf(value);
    if (proto !== null && proto !== Object.prototype) return false;

    for (const key of Object.keys(value)) {
      if (!isJsonValue(value[key], seen)) return false;
    }
    return true;
  }

  return false;
}

/**
 * Validate that a value is JSON-compatible.
 */
function validateJson(value: unknown) {
  return isJsonValue(value) ? ok(value as JsonValue) : NOT_JSON_ERROR;
}

/**
 * Create a JSON schema that validates any JSON-compatible value.
 * Accepts: strings, numbers (finite), booleans, null, arrays, plain objects.
 * Rejects: undefined, functions, symbols, bigint, circular references, class instances.
 *
 * @example
 * const data = v.json();
 * const optionalData = v.json({ optional: true });
 * const nullableData = v.json({ nullable: true });
 */
// @__NO_SIDE_EFFECTS__
export function json<
  const Opts extends ScalarOptions<JsonValue, any> | undefined = undefined,
>(
  options?: Opts
): JsonSchema<ComputeInput<JsonValue, Opts>, ComputeOutput<JsonValue, Opts>> {
  return buildSchema("json", validateJson, options) as JsonSchema<
    ComputeInput<JsonValue, Opts>,
    ComputeOutput<JsonValue, Opts>
  >;
}

// Export for reuse
export { validateJson, isJsonValue };
