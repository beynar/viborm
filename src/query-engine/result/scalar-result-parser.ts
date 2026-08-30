import { tryParseJsonString } from "@adapters/shared/result-parsing";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  type DateTimeNumericForm,
  decodePhysicalDateTime,
} from "@validation/primitives/datetime-physical-codec";
import type { Operation } from "../types";
import { QueryEngineError } from "../types";
import {
  type DecimalColumn,
  decodeDecimalListValue,
  decodeDecimalValue,
  decodeWidenedSumValue,
  materializeDecimalValue,
  materializeWidenedSumValue,
} from "./decimal-result-decode";
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
  operation: Operation,
  decimalColumn: DecimalColumn | undefined,
  materializeDecimal = false,
  dateTimeForm?: DateTimeNumericForm,
  enumListArrayText = false
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
      operation,
      decimalColumn,
      materializeDecimal,
      dateTimeForm
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

  // A decimal list is read as ONE container by the one codec, before the
  // generic list decode below can look at it. Splitting a container into
  // members with `JSON.parse` and then decoding each one would put a second
  // interpreter in front of the codec's grammar — and that interpreter reads a
  // JSON numeric token as a number, which is the loss plan 6.1 forbids.
  if (decimalColumn !== undefined) {
    const members = decodeDecimalListValue(value, decimalColumn);
    if (members === undefined) {
      return malformedScalarValue(
        provider,
        operation,
        scalarType,
        "the value is not an exact decimal list in this column's declared domain"
      );
    }
    return members;
  }

  let items: unknown = value;
  if (typeof items === "string") {
    // The provider array reading applies only where the adapter DECLARED that
    // an enum list answers in array text (PostgreSQL), and comes first there
    // because the two spellings collide on the empty container: `{}` is an
    // empty PostgreSQL array AND a valid JSON object. A JSON-dialect enum list
    // keeps the JSON reading — and its malformed-row refusal — like every
    // other list.
    const parsed =
      (scalarType === "enum" && enumListArrayText
        ? providerArrayMembers(items)
        : undefined) ?? tryParseJsonString(items);
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
      operation,
      decimalColumn
    );
  }
  return parsedItems;
}

/**
 * The members of a list a provider answered with in its own array text —
 * `{ADMIN,"a,b"}`.
 *
 * An enum list is the one list a driver can hand back unparsed. PostgreSQL
 * stores it as an array of a type the ESTATE created, whose OID is in no
 * driver's result-type table, so the driver returns the array's output text
 * instead of members. Every other list, on every dialect, arrives as a JS array
 * or as the JSON container the reader above already opens.
 *
 * The grammar is the server's output form: one dimension, comma-separated,
 * a member quoted when it would otherwise be ambiguous, with `"` and `\`
 * backslash-escaped inside the quotes, and an unquoted `NULL` for the null
 * member — which the member decode then refuses for a non-nullable element.
 */
function providerArrayMembers(text: string): unknown[] | undefined {
  if (!(text.startsWith("{") && text.endsWith("}"))) return undefined;
  const body = text.slice(1, -1);
  if (body.length === 0) return [];

  const members: unknown[] = [];
  let cursor = 0;
  while (cursor <= body.length) {
    const member =
      body[cursor] === '"'
        ? readQuotedMember(body, cursor)
        : readBareMember(body, cursor);
    if (member === undefined) return undefined;
    members.push(member.value);
    // The member ends the literal, or the delimiter follows it.
    if (member.next === body.length) return members;
    if (body[member.next] !== ",") return undefined;
    cursor = member.next + 1;
  }
  return undefined;
}

/** One `"…"` member, and the offset just past its closing quote. */
function readQuotedMember(
  body: string,
  start: number
): { value: string; next: number } | undefined {
  let value = "";
  let cursor = start + 1;
  while (cursor < body.length) {
    const char = body.charAt(cursor);
    if (char === '"') return { value, next: cursor + 1 };
    // A backslash escapes exactly the next character, whatever it is.
    const escaped = char === "\\";
    value += escaped ? body.charAt(cursor + 1) : char;
    cursor += escaped ? 2 : 1;
  }
  return undefined;
}

/** One unquoted member, and the offset of the delimiter that ends it. */
function readBareMember(
  body: string,
  start: number
): { value: unknown; next: number } | undefined {
  const delimiter = body.indexOf(",", start);
  const next = delimiter === -1 ? body.length : delimiter;
  const raw = body.slice(start, next);
  if (raw.length === 0) return undefined;
  return { value: raw === "NULL" ? null : raw, next };
}

/**
 * Decode one aggregate SUM into canonical private text or its public value.
 *
 * A sum is the one leaf that leaves the column's domain: it preserves the
 * declared scale and outgrows the declared precision, so holding it to the
 * column would refuse arithmetic the database performed exactly. It is still
 * held to the promised physical vocabulary, so a provider that answers with a
 * double is a malformed row rather than a rounded sum.
 */
export function parseWidenedSumDefault(
  value: unknown,
  decimalColumn: DecimalColumn | undefined,
  scalarType: string,
  provider: string,
  operation: Operation,
  materializePublic = false
): unknown {
  const parsed =
    decimalColumn === undefined
      ? undefined
      : materializePublic
        ? materializeWidenedSumValue(value, decimalColumn)
        : decodeWidenedSumValue(value, decimalColumn);
  if (parsed === undefined) {
    return malformedScalarValue(
      provider,
      operation,
      scalarType,
      "the sum is not an exact decimal at this column's scale"
    );
  }
  return parsed;
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
  operation: Operation,
  decimalColumn: DecimalColumn | undefined,
  materializeDecimal = false,
  dateTimeForm?: DateTimeNumericForm
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
      // A column whose declared native form is a NUMBER is read by the codec
      // that wrote it, before the provider-timestamp grammar below can look at
      // it. Nothing in the value says which form it is — the same number is one
      // instant as epoch milliseconds and another as a Julian day — so the
      // declaration is what routes it, and a value outside that form's exact
      // vocabulary is a malformed row rather than an instant to guess at.
      if (dateTimeForm !== undefined) {
        const decoded = decodePhysicalDateTime(value, dateTimeForm);
        if (decoded === undefined) {
          return malformedScalarValue(
            provider,
            operation,
            scalarType,
            "the value is not this column's declared physical timestamp"
          );
        }
        return decoded;
      }
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

    case "number": {
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

    // A decimal NEVER becomes a JS number here. Identity and list paths answer
    // with canonical private text. An ordinary uncaptured public scalar asks
    // the same codec scan to construct its one public Decimal directly.
    //
    // The accepted spelling is the exact physical one the active adapter
    // promised for THIS column, held to its declared precision and scale: a
    // decimal that arrives outside either is a column the schema no longer
    // describes, not a value to widen the field for.
    case "decimal": {
      const parsed =
        decimalColumn === undefined
          ? undefined
          : materializeDecimal
            ? materializeDecimalValue(value, decimalColumn)
            : decodeDecimalValue(value, decimalColumn);
      if (parsed === undefined) {
        return malformedScalarValue(
          provider,
          operation,
          scalarType,
          "the value is not an exact decimal in this column's declared domain"
        );
      }
      return parsed;
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
