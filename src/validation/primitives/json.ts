import { isFieldRef } from "@schema/field-ref";
import type {
  ComputeInput,
  ComputeOutput,
  ScalarOptions,
  ValidationResult,
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

/** JSON serialization omits undefined object members and nulls array holes. */
export type JsonInput =
  | string
  | number
  | boolean
  | null
  | readonly (JsonInput | undefined)[]
  | { [key: string]: JsonInput | undefined };

/**
 * A JSON value in WRITE position: everything `JsonValue` allows EXCEPT a bare
 * top-level `null`.
 *
 * Once `DbNull` and `JsonNull` exist, a top-level `null` no longer says which
 * of the two nulls it means, so it is not a legal write value — the same line
 * Prisma draws with its own `InputJsonValue`. Nested nulls are untouched:
 * `{ a: null }` is an ordinary document.
 */
export type InputJsonValue = Exclude<JsonInput, null>;

export interface BaseJsonSchema<
  Opts extends ScalarOptions<JsonInput, any> | undefined = undefined,
> extends VibSchema<
    ComputeInput<JsonInput, Opts>,
    ComputeOutput<JsonValue, Opts>
  > {}

export interface JsonSchema<TInput = JsonInput, TOutput = JsonValue>
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
const INVALID_JSON = Symbol("invalid JSON");

function normalizeJson(
  value: unknown,
  seen = new WeakMap<object, JsonValue | typeof INVALID_JSON>()
): JsonValue | typeof INVALID_JSON {
  if (value === null || isString(value) || isBoolean(value)) return value;
  if (isNumber(value)) return Number.isFinite(value) ? value : INVALID_JSON;
  if (!(isRecord(value) || Array.isArray(value))) return INVALID_JSON;
  if (isFieldRef(value)) return INVALID_JSON;
  const previous = seen.get(value);
  if (previous !== undefined) return previous;
  seen.set(value, INVALID_JSON); // A back-edge is a cycle; completed aliases are reusable.
  if (Array.isArray(value)) {
    const result: JsonValue[] = [];
    for (const original of value) {
      const member =
        original === undefined ? null : normalizeJson(original, seen);
      if (member === INVALID_JSON) return INVALID_JSON;
      result.push(member);
    }
    seen.set(value, result);
    return result;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) return INVALID_JSON;
  const result: Record<string, JsonValue> = {};
  for (const key of Object.keys(value)) {
    const original = value[key];
    if (original === undefined) {
      continue;
    }
    const member = normalizeJson(original, seen);
    if (member === INVALID_JSON) return INVALID_JSON;
    Object.defineProperty(result, key, {
      value: member,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  seen.set(value, result);
  return result;
}

/**
 * Validate that a value is JSON-compatible.
 */
function validateJson(value: unknown): ValidationResult<JsonValue> {
  const normalized = normalizeJson(value);
  return normalized === INVALID_JSON ? NOT_JSON_ERROR : ok(normalized);
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
  const Opts extends ScalarOptions<JsonInput, any> | undefined = undefined,
>(
  options?: Opts
): JsonSchema<ComputeInput<JsonInput, Opts>, ComputeOutput<JsonValue, Opts>> {
  return buildSchema<JsonInput, Opts | undefined>(
    "json",
    validateJson,
    options
  ) as JsonSchema<
    ComputeInput<JsonInput, Opts>,
    ComputeOutput<JsonValue, Opts>
  >;
}

// Export for reuse
export { validateJson };
