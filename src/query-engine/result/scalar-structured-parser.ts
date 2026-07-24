import { tryParseJsonString } from "@adapters/shared/result-parsing";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Operation } from "../types";
import { malformedScalarValue } from "./result-parser-contract";

const FINITE_NUMBER_VALUE_REGEX =
  /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

export function parseVectorValue(
  value: unknown,
  dimension: number | undefined,
  provider: string,
  operation: Operation
): number[] {
  const decoded = typeof value === "string" ? tryParseJsonString(value) : value;
  if (!Array.isArray(decoded)) {
    return malformedScalarValue(
      provider,
      operation,
      "vector",
      "the value is not an array or JSON array text"
    );
  }
  if (dimension !== undefined && decoded.length !== dimension) {
    return malformedScalarValue(
      provider,
      operation,
      "vector",
      `the value does not have the configured dimension ${dimension}`
    );
  }

  const result = new Array<number>(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    if (!Object.hasOwn(decoded, index)) {
      return malformedScalarValue(
        provider,
        operation,
        "vector",
        "the value is a sparse array"
      );
    }
    const item = decoded[index];
    if (typeof item !== "number" || !Number.isFinite(item)) {
      return malformedScalarValue(
        provider,
        operation,
        "vector",
        "every coordinate must be a finite number"
      );
    }
    result[index] = item;
  }
  return result;
}

const POINT_TEXT_REGEX = /^\(([^,()]+),([^,()]+)\)$/;

export function parsePointValue(
  value: unknown,
  provider: string,
  operation: Operation
): { x: number; y: number } {
  if (typeof value === "string") {
    const match = POINT_TEXT_REGEX.exec(value);
    const x = match ? parseFiniteProviderNumber(match[1]) : undefined;
    const y = match ? parseFiniteProviderNumber(match[2]) : undefined;
    if (x !== undefined && y !== undefined) return { x, y };
    return malformedScalarValue(
      provider,
      operation,
      "point",
      "the value is not canonical PostgreSQL point text"
    );
  }

  if (
    !isPlainJsonRecord(value) ||
    Reflect.ownKeys(value).length !== 2 ||
    !Object.hasOwn(value, "x") ||
    !Object.hasOwn(value, "y") ||
    typeof value.x !== "number" ||
    !Number.isFinite(value.x) ||
    typeof value.y !== "number" ||
    !Number.isFinite(value.y)
  ) {
    return malformedScalarValue(
      provider,
      operation,
      "point",
      "the value is not an exact finite { x, y } object"
    );
  }
  return { x: value.x, y: value.y };
}

export function parseJsonValueWithSchema(
  value: unknown,
  schema: StandardSchemaV1 | undefined,
  provider: string,
  operation: Operation
): unknown {
  const jsonValue = parseJsonValue(value, provider, operation, "json");
  if (!schema) return jsonValue;

  let validation:
    | StandardSchemaV1.Result<unknown>
    | Promise<StandardSchemaV1.Result<unknown>>;
  try {
    validation = schema["~standard"].validate(jsonValue);
  } catch {
    return malformedScalarValue(
      provider,
      operation,
      "json",
      "custom output schema validation failed"
    );
  }
  if (isPromiseLike(validation)) {
    Promise.resolve(validation).catch(() => undefined);
    return malformedScalarValue(
      provider,
      operation,
      "json",
      "asynchronous custom output schemas are not supported"
    );
  }
  if (validation.issues) {
    return malformedScalarValue(
      provider,
      operation,
      "json",
      "custom output schema rejected the value"
    );
  }
  return parseJsonValue(validation.value, provider, operation, "json");
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}

export function parseFiniteProviderNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "bigint") {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  if (typeof value !== "string" || !FINITE_NUMBER_VALUE_REGEX.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseJsonValue(
  value: unknown,
  provider: string,
  operation: Operation,
  scalarType: string
): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
    return malformedScalarValue(
      provider,
      operation,
      scalarType,
      "a JSON number is not finite"
    );
  }
  if (typeof value === "bigint") {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
    return malformedScalarValue(
      provider,
      operation,
      scalarType,
      "a JSON integer is outside the safe range"
    );
  }
  if (Array.isArray(value)) {
    const result = new Array<unknown>(value.length);
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        return malformedScalarValue(
          provider,
          operation,
          scalarType,
          "a JSON array is sparse"
        );
      }
      result[index] = parseJsonValue(
        value[index],
        provider,
        operation,
        scalarType
      );
    }
    return result;
  }
  if (isPlainJsonRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: parseJsonValue(item, provider, operation, scalarType),
        writable: true,
      });
    }
    return result;
  }
  return malformedScalarValue(
    provider,
    operation,
    scalarType,
    "the value is outside the JSON value domain"
  );
}

function isPlainJsonRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
