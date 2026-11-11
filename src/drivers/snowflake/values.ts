/**
 * Values across Snowflake's SQL API, both ways, exactly.
 *
 * The API binds every parameter as a typed string
 * (docs.snowflake.com/en/developer-guide/sql-api/submitting-requests) and
 * answers every value as a string, typed by the result's `rowType`
 * (…/handling-responses). Nothing here goes through a JavaScript `number`
 * unless the value fits one exactly:
 *
 * | Snowflake               | read as                                            |
 * | ----------------------- | -------------------------------------------------- |
 * | `NUMBER(p,0)`           | `number` when a safe integer, else `bigint`        |
 * | `NUMBER(p,s)`, s > 0    | the decimal text (`"12.50"`)                       |
 * | `FLOAT`                 | `number` (`inf`, `-inf`, `NaN` included)           |
 * | `TEXT`                  | `string`                                           |
 * | `BOOLEAN`               | `boolean`                                          |
 * | `DATE`                  | `"YYYY-MM-DD"`                                     |
 * | `TIME`                  | `"HH:MM:SS.fffffffff"`                             |
 * | `TIMESTAMP_NTZ` / `LTZ` | `"YYYY-MM-DDTHH:MM:SS.fffffffffZ"` (nanoseconds)    |
 * | `TIMESTAMP_TZ`          | the same at its own offset (`…+05:30`)             |
 * | `BINARY`                | `Uint8Array`                                       |
 * | `VARIANT`/`OBJECT`/`ARRAY`/`VECTOR` | the parsed JSON                        |
 * | anything else           | the text as answered                               |
 *
 * A `TIMESTAMP_NTZ` is a wall clock with no zone: VibORM reads it as UTC, and
 * the driver runs every statement with `TIMEZONE = 'UTC'`, so the database
 * compares it the same way.
 */

import { QueryError, VibORMErrorCode } from "@errors";

/** One `rowType` entry of a result set. */
export interface SnowflakeColumn {
  readonly name: string;
  readonly type: string;
  readonly scale?: number | null;
  readonly precision?: number | null;
  readonly nullable?: boolean;
}

export interface SnowflakeBinding {
  readonly type:
    | "FIXED"
    | "REAL"
    | "TEXT"
    | "BOOLEAN"
    | "BINARY"
    | "TIMESTAMP_TZ";
  readonly value: string | null;
}

const NANOS_PER_SECOND = 1_000_000_000n;
const NANOS_PER_MILLISECOND = 1_000_000n;
/** `TIMESTAMP_TZ` offsets travel as minutes plus 1440. */
const OFFSET_BIAS = 1440;
const NOT_HEX = /[^0-9a-fA-F]/;
const INTEGER = /^-?\d+$/;

function hex(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += byte.toString(16).padStart(2, "0");
  return text;
}

function unhex(text: string): Uint8Array {
  if (text.length % 2 !== 0 || NOT_HEX.test(text))
    throw malformed("BINARY", text);
  const bytes = new Uint8Array(text.length / 2);
  for (let index = 0; index < bytes.length; index++)
    bytes[index] = Number.parseInt(text.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

function malformed(type: string, value: string): QueryError {
  return new QueryError(
    `Snowflake answered a ${type} value VibORM cannot read: ${JSON.stringify(value.slice(0, 64))}.`,
    {
      code: VibORMErrorCode.QUERY_RESULT_INVALID,
      meta: { driver: "snowflake", type },
    }
  );
}

/** One parameter as the SQL API binds it. */
export function encodeBinding(value: unknown): SnowflakeBinding {
  if (value === null || value === undefined)
    return { type: "TEXT", value: null };
  switch (typeof value) {
    case "string":
      return { type: "TEXT", value };
    case "boolean":
      return { type: "BOOLEAN", value: value ? "true" : "false" };
    case "bigint":
      return { type: "FIXED", value: value.toString() };
    case "number":
      if (Number.isInteger(value))
        return { type: "FIXED", value: BigInt(value).toString() };
      if (Number.isNaN(value)) return { type: "REAL", value: "NaN" };
      if (!Number.isFinite(value))
        return { type: "REAL", value: value > 0 ? "inf" : "-inf" };
      // The shortest text that reads back as this double.
      return { type: "REAL", value: String(value) };
    default:
      break;
  }
  if (value instanceof Date) {
    const time = value.getTime();
    if (Number.isNaN(time))
      throw new QueryError("An invalid Date cannot be bound.", {
        code: VibORMErrorCode.INVALID_INPUT,
        meta: { driver: "snowflake" },
      });
    return {
      type: "TIMESTAMP_TZ",
      value: `${BigInt(time) * NANOS_PER_MILLISECOND} ${OFFSET_BIAS}`,
    };
  }
  if (value instanceof Uint8Array) return { type: "BINARY", value: hex(value) };
  if (typeof value === "object")
    return {
      type: "TEXT",
      value: JSON.stringify(value, (_key, member) =>
        typeof member === "bigint" ? member.toString() : member
      ),
    };
  throw new QueryError(`A ${typeof value} cannot be bound to Snowflake.`, {
    code: VibORMErrorCode.INVALID_INPUT,
    meta: { driver: "snowflake" },
  });
}

/** Every parameter, keyed `"1"`, `"2"`, … as the `?` placeholders count. */
export function encodeBindings(
  params: readonly unknown[]
): Record<string, SnowflakeBinding> | undefined {
  if (params.length === 0) return undefined;
  const bindings: Record<string, SnowflakeBinding> = {};
  for (const [index, value] of params.entries())
    bindings[String(index + 1)] = encodeBinding(value);
  return bindings;
}

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;

/** `-12.5` seconds as exact nanoseconds. */
function nanoseconds(text: string, type: string): bigint {
  const match = DECIMAL.exec(text);
  if (!match) throw malformed(type, text);
  const [, sign, whole, fraction = ""] = match;
  if (fraction.length > 9) throw malformed(type, text);
  const nanos =
    BigInt(whole!) * NANOS_PER_SECOND + BigInt(fraction.padEnd(9, "0"));
  return sign ? -nanos : nanos;
}

const pad = (value: number, width = 2): string =>
  String(value).padStart(width, "0");

/** A calendar date of the proleptic Gregorian calendar, years beyond 9999 signed. */
function isoDate(date: Date): string {
  const year = date.getUTCFullYear();
  const yearText =
    year >= 0 && year <= 9999
      ? pad(year, 4)
      : `${year < 0 ? "-" : "+"}${pad(Math.abs(year), 6)}`;
  return `${yearText}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** Exact nanoseconds since the epoch as an ISO date-time, without a zone. */
function isoLocal(nanos: bigint): string {
  let seconds = nanos / NANOS_PER_SECOND;
  let fraction = nanos % NANOS_PER_SECOND;
  if (fraction < 0n) {
    fraction += NANOS_PER_SECOND;
    seconds -= 1n;
  }
  const date = new Date(Number(seconds) * 1000);
  const clock = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
  return `${isoDate(date)}T${clock}.${fraction.toString().padStart(9, "0")}`;
}

function offsetText(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const magnitude = Math.abs(minutes);
  return `${sign}${pad(Math.floor(magnitude / 60))}:${pad(magnitude % 60)}`;
}

/** One answered value, as the table above says. */
export function decodeValue(column: SnowflakeColumn, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return value;
  const type = column.type.toLowerCase();
  switch (type) {
    case "fixed": {
      if ((column.scale ?? 0) > 0) return value;
      if (!INTEGER.test(value)) throw malformed("NUMBER", value);
      const number = Number(value);
      return Number.isSafeInteger(number) ? number : BigInt(value);
    }
    case "real": {
      const lowered = value.toLowerCase();
      if (lowered === "inf" || lowered === "infinity")
        return Number.POSITIVE_INFINITY;
      if (lowered === "-inf" || lowered === "-infinity")
        return Number.NEGATIVE_INFINITY;
      if (lowered === "nan") return Number.NaN;
      const number = Number(value);
      if (Number.isNaN(number)) throw malformed("FLOAT", value);
      return number;
    }
    case "boolean":
      if (value === "true" || value === "1") return true;
      if (value === "false" || value === "0") return false;
      throw malformed("BOOLEAN", value);
    case "date": {
      if (!INTEGER.test(value)) throw malformed("DATE", value);
      return isoDate(new Date(Number(value) * 86_400_000));
    }
    case "time":
      return isoLocal(nanoseconds(value, "TIME")).slice(11);
    case "timestamp_ntz":
    case "timestamp_ltz":
      return `${isoLocal(nanoseconds(value, column.type))}Z`;
    case "timestamp_tz": {
      const [instant, bias] = value.split(" ");
      const minutes = Number(bias) - OFFSET_BIAS;
      if (!(instant && Number.isInteger(minutes)))
        throw malformed("TIMESTAMP_TZ", value);
      const local =
        nanoseconds(instant, column.type) +
        BigInt(minutes) * 60n * NANOS_PER_SECOND;
      return `${isoLocal(local)}${offsetText(minutes)}`;
    }
    case "binary":
      return unhex(value);
    case "variant":
    case "object":
    case "array":
    case "map":
    case "vector":
      try {
        return JSON.parse(value);
      } catch {
        throw malformed(column.type.toUpperCase(), value);
      }
    default:
      return value;
  }
}

/** One answered row, keyed by its columns' names. */
export function decodeRow<T = Record<string, unknown>>(
  columns: readonly SnowflakeColumn[],
  row: readonly unknown[]
): T {
  const decoded: T = Object.create(Object.prototype);
  // Defined, not assigned: a column named `__proto__` is a column.
  for (const [index, column] of columns.entries())
    Object.defineProperty(decoded, column.name, {
      value: decodeValue(column, row[index]),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  return decoded;
}
