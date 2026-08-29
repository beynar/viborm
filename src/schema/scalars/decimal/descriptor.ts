/**
 * The definition boundary for `s.decimal({ precision, scale })`.
 *
 * A scale cannot be inferred from storage, a value, a driver, or an operation:
 * SQLite ignores the numbers in `DECIMAL(10,5)` and may put a fractional value
 * in a binary64 double. So the domain is DECLARED once, here, and every later
 * consumer — validation, DDL, binding, decoding, comparison, arithmetic,
 * migration — reads that one frozen fact off the resolved scalar.
 *
 * The descriptor object is hostile input. It may be a Proxy, carry accessors,
 * or be mutated after the call returns. Each property is therefore read exactly
 * once, from the object itself, with the presence test inside the same `try`
 * (a second read is what would let a value that passed validation be swapped
 * for one that did not), and what survives is a FROZEN COPY this module built —
 * never the caller's object.
 */

import { ValidationError } from "@errors";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { DecimalDescriptor } from "@validation/primitives/decimal-codec";
import { isFunction, isRecord } from "@validation/value-guards";
import { toError } from "../../../errors/diagnostic-safety";

const BUILDER = "s.decimal";
const DESCRIPTOR_KEYS: readonly string[] = ["precision", "scale"];

/** The one construction-time refusal of a decimal declaration. */
function refuse(path: string, message: string, cause?: Error): never {
  throw new ValidationError(
    { kind: "schema-builder", builder: BUILDER, path },
    [{ path, message }],
    cause === undefined ? undefined : { cause }
  );
}

/**
 * Read one descriptor property exactly once, from the object itself.
 *
 * `Object.hasOwn` shares the `try` with the `Reflect.get` so a hostile
 * `getOwnPropertyDescriptor` trap fails exactly like a hostile accessor, and it
 * is not a second read of the value: it consults the descriptor, not the
 * getter. An inherited value is prototype pollution or a carrier's prototype,
 * never a domain this author wrote down.
 */
function readOnce(source: object, key: string): unknown {
  try {
    if (!Object.hasOwn(source, key)) return undefined;
    return Reflect.get(source, key);
  } catch (thrown) {
    refuse(
      `descriptor.${key}`,
      `Could not read '${key}' from the decimal descriptor`,
      toError(thrown)
    );
  }
}

/**
 * EVERY own key, with a throwing `ownKeys` trap owned as a refusal.
 *
 * `Reflect.ownKeys` rather than `Object.keys`: a declaration is an OWN
 * property, and neither a symbol key nor `enumerable: false` changes that.
 * Enumerability is presentation and a symbol is a key shape; an object carrying
 * either beside `{ precision, scale }` is naming something this domain has no
 * word for, and guessing which half the author meant is exactly the silent
 * acceptance the definition boundary exists to prevent.
 */
function ownKeys(source: Record<string, unknown>): (string | symbol)[] {
  try {
    return Reflect.ownKeys(source);
  } catch (thrown) {
    refuse(
      "descriptor",
      "Could not enumerate the decimal descriptor's keys",
      toError(thrown)
    );
  }
}

/**
 * The refusal path and the phrase that names one unexpected own key.
 *
 * A symbol is named by its own `description`, spelled the way JavaScript spells
 * it. `String(symbol)` and a template literal are coercions — one runs library
 * code and the other throws — and this module names a caller's value by what it
 * is rather than by running anything to render it.
 */
function nameUnknownKey(key: string | symbol): [string, string] {
  if (typeof key === "string") return [`descriptor.${key}`, `'${key}'`];
  return ["descriptor", `Symbol(${key.description ?? ""})`];
}

/** `isRecord`, whose own `Array.isArray` throws on a revoked proxy. */
function isDescriptorObject(
  source: unknown
): source is Record<string, unknown> {
  try {
    return isRecord(source);
  } catch (thrown) {
    refuse(
      "descriptor",
      "Could not inspect the decimal descriptor",
      toError(thrown)
    );
  }
}

/**
 * One descriptor number: present, an integer, never `-0`, and in range.
 *
 * `-0` behaves like `0` in every conversion this codec performs, but it does
 * not survive JSON, so a state carrying it would serialize to a schema document
 * that reads back as a different declaration. It is refused where it is written
 * rather than tolerated everywhere it is read.
 */
function readBound(
  source: object,
  key: string,
  low: number,
  high: number,
  highLabel: string
): number {
  const value = readOnce(source, key);
  const path = `descriptor.${key}`;
  if (value === undefined) {
    refuse(path, `A decimal must declare '${key}'`);
  }
  if (typeof value !== "number") {
    // The caller's value is named by TYPE, never coerced: rendering an object
    // would run its own `toString`, which is more caller code.
    refuse(
      path,
      `'${key}' must be an integer; received a value of type '${typeof value}'`
    );
  }
  if (!Number.isInteger(value)) {
    refuse(path, `'${key}' must be an integer`);
  }
  if (Object.is(value, -0)) {
    refuse(path, `'${key}' must not be negative zero`);
  }
  if (value < low || value > high) {
    refuse(path, `'${key}' must be between ${low} and ${highLabel}`);
  }
  return value;
}

/**
 * The trusted, frozen fixed-decimal domain named by a caller-owned object.
 *
 * `precision` is the maximum total digit count of the unscaled coefficient and
 * `scale` the maximum fractional digit count, so `scale <= precision` is what
 * makes "at most `precision` total digits and at most `scale` fractional
 * digits" a domain with values in it at all. Whether a given PROVIDER can store that domain is a
 * different question with a different owner: the adapter answers it once when
 * the schema is bound, so a model valid for PostgreSQL stays a valid model.
 */
export function readDecimalDescriptor(source: unknown): DecimalDescriptor {
  if (!isDescriptorObject(source)) {
    refuse(
      "descriptor",
      `A decimal must declare { precision, scale }; received a value of type '${typeof source}'`
    );
  }
  const precision = readBound(
    source,
    "precision",
    1,
    Number.MAX_SAFE_INTEGER,
    "the maximum safe integer"
  );
  const scale = readBound(source, "scale", 0, precision, "precision");
  for (const key of ownKeys(source)) {
    if (typeof key === "string" && DESCRIPTOR_KEYS.includes(key)) continue;
    const [path, named] = nameUnknownKey(key);
    refuse(
      path,
      `${named} is not a decimal descriptor property; a decimal declares { precision, scale }`
    );
  }
  return Object.freeze({ precision, scale });
}

/**
 * A fixed-decimal LIST is not a key, and this is where a chain that tries to
 * make one into a key stops (plan 2.1).
 *
 * Both directions are refused because the chain has two of them:
 * `.array().id()` names a list and then a key, `.id().array()` names a key and
 * then a list, and only refusing the one that comes second would leave the
 * other spelling admitted. The exclusion is the DECLARATION's, not the
 * database's: a decimal list is stored as one container value on two of three
 * providers, so a key over it would be a key over a JSON document whose
 * identity is its spelling rather than its members — and there is no member
 * arrangement that could make it addressable.
 *
 * The whole-schema rule F007 ("an ID cannot be an array") is untouched and
 * still owns every OTHER scalar type. This refuses earlier, at the call that
 * writes the illegal chain, and it also owns `.unique()`, which no rule in the
 * repository refuses on a list of any type.
 */
export function refuseDecimalListKey(
  position: "id" | "unique" | "array"
): never {
  const explanation =
    "a fixed-decimal list cannot be an ID, a unique field, an index member, a foreign-key member, or a relation identity member";
  refuse(
    position,
    position === "array"
      ? `A decimal key cannot become a list: ${explanation}`
      : `A decimal list cannot be declared '.${position}()': ${explanation}`
  );
}

/** Snapshot one caller-owned list before the field validator can inspect it. */
function snapshotDecimalDefaultList(value: unknown): unknown[] {
  let list: unknown[] | undefined;
  try {
    if (Array.isArray(value)) list = value;
  } catch (thrown) {
    refuse(
      "default",
      "Could not snapshot the decimal list default",
      toError(thrown)
    );
  }
  if (list === undefined) {
    refuse("default", "A decimal list default must be an array");
  }

  let length: unknown;
  let keys: (string | symbol)[];
  try {
    length = Reflect.get(list, "length");
    keys = Reflect.ownKeys(list);
  } catch (thrown) {
    refuse(
      "default",
      "Could not snapshot the decimal list default",
      toError(thrown)
    );
  }
  if (
    typeof length !== "number" ||
    !Number.isInteger(length) ||
    length < 0 ||
    keys.length !== length + 1
  ) {
    refuse(
      "default",
      "A decimal list default must be a dense array with no shadow properties"
    );
  }

  const keySet = new Set<PropertyKey>(keys);
  const snapshot = new Array<unknown>(length);
  for (let index = 0; index < length; index++) {
    if (!keySet.has(String(index))) {
      refuse(
        "default",
        "A decimal list default must be a dense array with no shadow properties"
      );
    }
    try {
      snapshot[index] = Reflect.get(list, String(index));
    } catch (thrown) {
      refuse(
        "default",
        "Could not snapshot the decimal list default",
        toError(thrown)
      );
    }
  }
  return snapshot;
}

/** Validate one literal through the field's complete current codec. */
function validateDecimalDefault(
  value: unknown,
  schema: StandardSchemaV1<unknown, unknown>
): unknown {
  let result: unknown;
  try {
    result = schema["~standard"].validate(value);
  } catch (thrown) {
    refuse(
      "default",
      "The decimal field schema failed while validating its default",
      toError(thrown)
    );
  }

  let resultRecord: Record<string, unknown> | undefined;
  try {
    if (isRecord(result)) resultRecord = result;
  } catch (thrown) {
    refuse(
      "default",
      "The decimal field schema failed while validating its default",
      toError(thrown)
    );
  }
  if (resultRecord === undefined) {
    refuse(
      "default",
      "The decimal field schema returned a malformed validation result"
    );
  }

  let then: unknown;
  try {
    then = Reflect.get(resultRecord, "then");
  } catch (thrown) {
    refuse(
      "default",
      "The decimal field schema failed while validating its default",
      toError(thrown)
    );
  }
  if (isFunction(then)) {
    refuse("default", "Async decimal field schemas are not supported");
  }

  let issues: unknown;
  try {
    issues = Reflect.get(resultRecord, "issues");
  } catch (thrown) {
    refuse(
      "default",
      "The decimal field schema failed while validating its default",
      toError(thrown)
    );
  }
  if (issues !== undefined) {
    refuse("default", "The decimal default did not satisfy its field schema");
  }

  let hasValue: boolean;
  try {
    hasValue = "value" in resultRecord;
  } catch (thrown) {
    refuse(
      "default",
      "The decimal field schema failed while validating its default",
      toError(thrown)
    );
  }
  if (!hasValue) {
    refuse(
      "default",
      "The decimal field schema returned a malformed validation result"
    );
  }

  try {
    return Reflect.get(resultRecord, "value");
  } catch (thrown) {
    refuse(
      "default",
      "The decimal field schema failed while validating its default",
      toError(thrown)
    );
  }
}

/**
 * A literal default, normalized through the complete current field codec at
 * DEFINITION time. Model metadata therefore already contains the canonical
 * logical value the serializer may trust; custom schemas, descriptor bounds,
 * nullability, and list arity have no second migration-time guard.
 *
 * A function default keeps its closure, exactly as every other scalar's does:
 * a closure has no canonical spelling to retain, and the schema-document
 * serializer already refuses one by name.
 */
export function normalizeDecimalDefault(
  value: unknown,
  schema: StandardSchemaV1<unknown, unknown>,
  array: boolean
): unknown {
  if (typeof value === "function") return value;
  const snapshot =
    array && value !== null ? snapshotDecimalDefaultList(value) : value;
  return validateDecimalDefault(snapshot, schema);
}
