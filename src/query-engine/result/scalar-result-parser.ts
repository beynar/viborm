import { tryParseJsonString } from "@adapters/shared/result-parsing";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { canonicalizeDecimal } from "@validation/primitives/decimal";
import type { Operation } from "../types";
import { QueryEngineError } from "../types";
import { malformedScalarValue } from "./result-parser-contract";
import { parseBlobValue } from "./scalar-blob-parser";
import {
  parseFiniteProviderNumber,
  parseJsonValueWithSchema,
  parsePointValue,
  parseVectorValue,
} from "./scalar-structured-parser";

const ZONELESS_DATETIME_REGEX =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

/** Trailing timezone marker on a time string: "+00", "+00:00", "-0530", "Z" */
const TIME_ZONE_SUFFIX_REGEX = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/;

/** Redundant zeros in a fractional-seconds suffix: ".000000" or ".1230" → ".123" */
const TRAILING_FRACTION_ZEROS_REGEX = /\.?0+$/;

const SIGNED_INTEGER_VALUE_REGEX = /^(?:0|-[1-9]\d*|[1-9]\d*)$/;
const DATE_VALUE_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_VALUE_REGEX =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(?:(Z)|([+-])(\d{2}):(\d{2}))?$/;
const TIME_VALUE_REGEX =
  /^(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-](\d{2})(?::?(\d{2}))?)?$/;

function parseDateTimeString(value: string): Date {
  if (ZONELESS_DATETIME_REGEX.test(value)) {
    return new Date(`${value.replace(" ", "T")}Z`);
  }
  return new Date(value);
}

export function parseFieldValueDefault(
  value: unknown,
  scalarType: string,
  isList: boolean,
  isNullable: boolean,
  enumValues: ReadonlySet<string> | undefined,
  vectorDimension: number | undefined,
  jsonSchema: StandardSchemaV1 | undefined,
  provider: string,
  operation: Operation
): unknown {
  if (!isList) {
    return parseTypedValueDefault(
      value,
      scalarType,
      isNullable,
      enumValues,
      vectorDimension,
      jsonSchema,
      provider,
      operation
    );
  }
  if (value === null) {
    if (isNullable) return null;
    return malformedScalarValue(
      provider,
      operation,
      scalarType,
      "a required list is null"
    );
  }

  let items: unknown = value;
  if (typeof items === "string") {
    const parsed = tryParseJsonString(items);
    if (parsed !== undefined) {
      items = parsed;
    }
  }
  if (!Array.isArray(items)) {
    return malformedScalarValue(
      provider,
      operation,
      scalarType,
      "a list scalar did not return an array"
    );
  }

  const parsedItems = new Array<unknown>(items.length);
  for (let index = 0; index < items.length; index += 1) {
    if (!Object.hasOwn(items, index)) {
      return malformedScalarValue(
        provider,
        operation,
        scalarType,
        "a list scalar returned a sparse array"
      );
    }
    parsedItems[index] = parseTypedValueDefault(
      items[index],
      scalarType,
      false,
      enumValues,
      vectorDimension,
      jsonSchema,
      provider,
      operation
    );
  }
  return parsedItems;
}

/**
 * Default field value parsing (called via adapter's next())
 */
function parseTypedValueDefault(
  value: unknown,
  scalarType: string,
  isNullable: boolean,
  enumValues: ReadonlySet<string> | undefined,
  vectorDimension: number | undefined,
  jsonSchema: StandardSchemaV1 | undefined,
  provider: string,
  operation: Operation
): unknown {
  if (value === null) {
    if (isNullable) return null;
    if (scalarType === "json") {
      return parseJsonValueWithSchema(value, jsonSchema, provider, operation);
    }
    return malformedScalarValue(
      provider,
      operation,
      scalarType,
      "a required scalar is null"
    );
  }
  if (value === undefined) {
    return malformedScalarValue(
      provider,
      operation,
      scalarType,
      "the value is absent"
    );
  }

  // Blob before the array branch: a number[] is one binary value, not a list
  if (scalarType === "blob") {
    return parseBlobValue(value, provider, operation);
  }

  switch (scalarType) {
    case "datetime": {
      if (value instanceof Date) {
        if (!Number.isNaN(value.getTime())) return value;
        return malformedScalarValue(
          provider,
          operation,
          scalarType,
          "the Date is invalid"
        );
      }
      if (typeof value !== "string" || !isValidDateTimeString(value)) {
        return malformedScalarValue(
          provider,
          operation,
          scalarType,
          "the value is not a valid provider timestamp"
        );
      }
      const parsed = parseDateTimeString(value);
      if (Number.isNaN(parsed.getTime())) {
        return malformedScalarValue(
          provider,
          operation,
          scalarType,
          "the timestamp is invalid"
        );
      }
      return parsed;
    }

    case "date": {
      if (value instanceof Date) {
        if (
          !Number.isNaN(value.getTime()) &&
          value.getUTCHours() === 0 &&
          value.getUTCMinutes() === 0 &&
          value.getUTCSeconds() === 0 &&
          value.getUTCMilliseconds() === 0
        ) {
          return value;
        }
        return malformedScalarValue(
          provider,
          operation,
          scalarType,
          "the Date is invalid or not UTC midnight"
        );
      }
      const match =
        typeof value === "string" ? DATE_VALUE_REGEX.exec(value) : null;
      if (!(match && isValidCalendarDate(match[1], match[2], match[3]))) {
        return malformedScalarValue(
          provider,
          operation,
          scalarType,
          "the value is not a valid ISO calendar date"
        );
      }
      return new Date(`${value}T00:00:00.000Z`);
    }

    case "bigint": {
      if (typeof value === "bigint") return value;
      if (typeof value === "number" && Number.isSafeInteger(value)) {
        return BigInt(value);
      }
      if (typeof value === "string" && SIGNED_INTEGER_VALUE_REGEX.test(value)) {
        return BigInt(value);
      }
      return malformedScalarValue(
        provider,
        operation,
        scalarType,
        "the value is not a canonical integer"
      );
    }

    case "int": {
      let parsed: number;
      if (typeof value === "number") {
        parsed = value;
      } else if (typeof value === "bigint") {
        parsed = Number(value);
      } else if (
        typeof value === "string" &&
        SIGNED_INTEGER_VALUE_REGEX.test(value)
      ) {
        parsed = Number(value);
      } else {
        return malformedScalarValue(
          provider,
          operation,
          scalarType,
          "the value is not a canonical integer"
        );
      }
      if (!Number.isSafeInteger(parsed)) {
        return malformedScalarValue(
          provider,
          operation,
          scalarType,
          "the integer is outside the safe range"
        );
      }
      return parsed;
    }

    case "float": {
      const parsed = parseFiniteProviderNumber(value);
      if (parsed === undefined) {
        return malformedScalarValue(
          provider,
          operation,
          scalarType,
          "the value is not a canonical finite number"
        );
      }
      return parsed;
    }

    // A decimal NEVER becomes a JS number here. Every provider hands the value
    // over as text already (PG `numeric`, mysql2 `DECIMAL`, SQLite's TEXT
    // column, and the `CAST(... AS TEXT)` the JSON select/aggregate paths add),
    // so the only work is agreeing on one spelling. Routing it through a double
    // — even briefly — is the precision loss this scalar exists to prevent.
    case "decimal": {
      const canonical = canonicalizeDecimal(value);
      if (canonical === undefined) {
        return malformedScalarValue(
          provider,
          operation,
          scalarType,
          "the value is not an exact decimal"
        );
      }
      return canonical;
    }

    case "boolean": {
      if (typeof value === "boolean") return value;
      if (value === 0 || value === 0n) return false;
      if (value === 1 || value === 1n) return true;
      return malformedScalarValue(
        provider,
        operation,
        scalarType,
        "the value is not true, false, zero, or one"
      );
    }

    case "time": {
      if (typeof value !== "string") {
        return malformedScalarValue(
          provider,
          operation,
          scalarType,
          "the value is not a valid provider time"
        );
      }
      const match = TIME_VALUE_REGEX.exec(value);
      if (!(match && isValidClock(match[1], match[2], match[3]))) {
        return malformedScalarValue(
          provider,
          operation,
          scalarType,
          "the value is not a valid provider time"
        );
      }
      const zoneHour = match[4] === undefined ? 0 : Number(match[4]);
      const zoneMinute = match[5] === undefined ? 0 : Number(match[5]);
      if (zoneHour > 23 || zoneMinute > 59) {
        return malformedScalarValue(
          provider,
          operation,
          scalarType,
          "the timezone suffix is invalid"
        );
      }
      let time = value.replace(TIME_ZONE_SUFFIX_REGEX, "");
      if (time.includes(".")) {
        time = time.replace(TRAILING_FRACTION_ZEROS_REGEX, "");
      }
      const fraction = time.split(".")[1];
      if (fraction && fraction.length > 3) {
        return malformedScalarValue(
          provider,
          operation,
          scalarType,
          "the normalized precision exceeds milliseconds"
        );
      }
      return time;
    }

    case "string":
      if (typeof value === "string") return value;
      return malformedScalarValue(
        provider,
        operation,
        scalarType,
        "the value is not a string"
      );

    case "enum":
      if (typeof value === "string" && enumValues?.has(value) === true) {
        return value;
      }
      return malformedScalarValue(
        provider,
        operation,
        scalarType,
        "the value is not a declared enum member"
      );

    case "json":
      return parseJsonValueWithSchema(value, jsonSchema, provider, operation);

    case "vector":
      return parseVectorValue(value, vectorDimension, provider, operation);

    case "point":
      return parsePointValue(value, provider, operation);

    default:
      return parseValueWithoutContext(value);
  }
}

function isValidDateTimeString(value: string): boolean {
  const match = DATETIME_VALUE_REGEX.exec(value);
  if (!match) return false;
  if (!isValidCalendarDate(match[1], match[2], match[3])) return false;
  if (!isValidClock(match[4], match[5], match[6])) return false;
  const hasZone = match[8] !== undefined || match[9] !== undefined;
  const separator = value[10];
  if (separator === " " && hasZone) return false;
  const zoneHour = match[10] === undefined ? 0 : Number(match[10]);
  const zoneMinute = match[11] === undefined ? 0 : Number(match[11]);
  return zoneHour <= 23 && zoneMinute <= 59;
}

function isValidCalendarDate(
  yearValue: string | undefined,
  monthValue: string | undefined,
  dayValue: string | undefined
): boolean {
  const year = Number(yearValue);
  const month = Number(monthValue);
  const day = Number(dayValue);
  if (month < 1 || month > 12 || day < 1) return false;
  const daysPerMonth = [
    31,
    isLeapYear(year) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return day <= (daysPerMonth[month - 1] ?? 0);
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function isValidClock(
  hourValue: string | undefined,
  minuteValue: string | undefined,
  secondValue: string | undefined
): boolean {
  const hour = Number(hourValue);
  const minute = Number(minuteValue);
  const second = Number(secondValue);
  return hour <= 23 && minute <= 59 && second <= 59;
}

function parseValueWithoutContext(value: unknown): unknown {
  if (value === undefined) {
    throw new QueryEngineError("Cannot parse an absent result value.");
  }
  if (value === null) {
    return null;
  }

  // Handle BigInt - keep as BigInt to preserve precision for large values
  // Users can convert to Number if needed for smaller values
  if (typeof value === "bigint") {
    return value;
  }

  // Try to parse JSON strings (MySQL/SQLite may return JSON as strings)
  if (typeof value === "string") {
    // Check if it looks like JSON
    const trimmed = value.trim();
    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        return JSON.parse(value);
      } catch {
        // Not valid JSON, return as-is
        return value;
      }
    }
    return value;
  }

  // Already parsed object (PostgreSQL returns JSON as objects)
  if (typeof value === "object") {
    // Preserve Date objects - they have no enumerable properties
    // so Object.entries would return empty array
    if (value instanceof Date) {
      return value;
    }

    // Preserve environment-neutral binary objects for schema-aware parsing.
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
      return value;
    }

    if (Array.isArray(value)) {
      return value.map(parseValueWithoutContext);
    }

    // Recursively parse nested objects (JSON scalars, etc.)
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = parseValueWithoutContext(v);
    }
    return result;
  }

  // Primitive values
  return value;
}
