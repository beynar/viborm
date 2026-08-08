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

export function isDate(value: unknown): value is Date {
  return value instanceof Date;
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
