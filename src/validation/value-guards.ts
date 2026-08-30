/**
 * Narrows an unknown value to the record representation used by validated
 * object inputs. This does not assert a plain prototype or safe property reads.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function isBigInt(value: unknown): value is bigint {
  return typeof value === "bigint";
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

/**
 * Identifies a Date by its `[[DateValue]]` slot, which only a `Date.prototype`
 * method can read: a Date from another realm passes, an object that merely
 * spells `getTime` does not. Whether that instant is NaN is a separate
 * question, owned by the schemas that consume this.
 */
export function isDate(value: unknown): value is Date {
  if (value instanceof Date) return true;
  // Non-objects hold no slot, and routing them through the throwing path would
  // cost every string an exception on the ISO timestamp boundary.
  if (value === null || typeof value !== "object") return false;
  try {
    Date.prototype.getTime.call(value);
    return true;
  } catch {
    return false;
  }
}

// %TypedArray%.prototype — home of the `Symbol.toStringTag` accessor that reads
// `[[TypedArrayName]]`.
const typedArrayPrototype: object = Object.getPrototypeOf(Uint8Array.prototype);

/**
 * Identifies a Uint8Array — a Node Buffer and one from another realm included —
 * by its `[[TypedArrayName]]` slot, so an own `Symbol.toStringTag` property, a
 * DataView, and every other typed-array kind are refused.
 */
export function isUint8Array(value: unknown): value is Uint8Array {
  return (
    value instanceof Uint8Array ||
    Reflect.get(typedArrayPrototype, Symbol.toStringTag, value) === "Uint8Array"
  );
}

export function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

type UnknownFunction = (...args: never[]) => unknown;

export function isFunction<FunctionType extends UnknownFunction>(
  value: unknown
): value is FunctionType {
  return typeof value === "function";
}
