import type {
  VibSchema,
  ScalarOptions,
  ComputeInput,
  ComputeOutput,
} from "../types";
import { buildSchema, ok } from "../helpers";

// =============================================================================
// ISO Format Validators
// =============================================================================

// ISO timestamp regex: 2023-12-15T10:30:00.000Z
const ISO_TIMESTAMP_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

// ISO date regex: 2023-12-15
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// ISO time regex: 10:30:00 or 10:30:00.000
const ISO_TIME_REGEX = /^\d{2}:\d{2}:\d{2}(\.\d{1,3})?$/;

// Pre-computed errors
const NOT_STRING_OR_DATE_ERROR = Object.freeze({
  issues: Object.freeze([
    Object.freeze({ message: "Expected string or Date" }),
  ]),
});

// =============================================================================
// ISO Timestamp Schema
// =============================================================================

export interface BaseIsoTimestampSchema<
  Opts extends ScalarOptions<string, any> | undefined = undefined
> extends VibSchema<ComputeInput<string | Date, Opts>, ComputeOutput<string, Opts>> {}

export interface IsoTimestampSchema<TInput = string | Date, TOutput = string>
  extends VibSchema<TInput, TOutput> {
  readonly type: "iso_timestamp";
}

// Pre-computed errors
const INVALID_TIMESTAMP_FORMAT = Object.freeze({
  issues: Object.freeze([
    Object.freeze({
      message: "Expected ISO timestamp format (YYYY-MM-DDTHH:mm:ss.sssZ)",
    }),
  ]),
});
const INVALID_TIMESTAMP_DATE = Object.freeze({
  issues: Object.freeze([
    Object.freeze({ message: "Invalid date in ISO timestamp" }),
  ]),
});

/**
 * Validate ISO timestamp format.
 * Accepts Date objects and converts them to ISO strings.
 */
function validateIsoTimestamp(value: unknown) {
  // Handle Date objects - convert to ISO string
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return INVALID_TIMESTAMP_DATE;
    return ok(value.toISOString());
  }

  if (typeof value !== "string") return NOT_STRING_OR_DATE_ERROR;
  if (!ISO_TIMESTAMP_REGEX.test(value)) return INVALID_TIMESTAMP_FORMAT;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return INVALID_TIMESTAMP_DATE;
  return ok(value);
}

/**
 * Create an ISO timestamp schema.
 * Accepts strings in format: 2023-12-15T10:30:00.000Z or Date objects.
 * Date objects are automatically converted to ISO strings.
 *
 * @example
 * const timestamp = v.isoTimestamp();
 * parse(timestamp, new Date()) // Returns ISO string
 */
export function isoTimestamp<
  const Opts extends ScalarOptions<string, any> | undefined = undefined
>(
  options?: Opts
): IsoTimestampSchema<
  ComputeInput<string | Date, Opts>,
  ComputeOutput<string, Opts>
> {
  return buildSchema(
    "iso_timestamp",
    validateIsoTimestamp,
    options
  ) as IsoTimestampSchema<
    ComputeInput<string | Date, Opts>,
    ComputeOutput<string, Opts>
  >;
}

// =============================================================================
// ISO Date Schema
// =============================================================================

export interface BaseIsoDateSchema<
  Opts extends ScalarOptions<string, any> | undefined = undefined
> extends VibSchema<ComputeInput<string | Date, Opts>, ComputeOutput<string, Opts>> {}

export interface IsoDateSchema<TInput = string | Date, TOutput = string>
  extends VibSchema<TInput, TOutput> {
  readonly type: "iso_date";
}

// Pre-computed errors
const INVALID_DATE_FORMAT = Object.freeze({
  issues: Object.freeze([
    Object.freeze({
      message: "Expected ISO date format (YYYY-MM-DD)",
    }),
  ]),
});
const INVALID_DATE = Object.freeze({
  issues: Object.freeze([Object.freeze({ message: "Invalid date" })]),
});

/**
 * Validate ISO date format.
 * Accepts Date objects and converts them to ISO date strings (YYYY-MM-DD).
 */
function validateIsoDate(value: unknown) {
  // Handle Date objects - convert to ISO date string
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return INVALID_DATE;
    return ok(value.toISOString().split("T")[0]!);
  }

  if (typeof value !== "string") return NOT_STRING_OR_DATE_ERROR;
  if (!ISO_DATE_REGEX.test(value)) return INVALID_DATE_FORMAT;
  const date = new Date(value + "T00:00:00Z");
  if (Number.isNaN(date.getTime())) return INVALID_DATE;
  return ok(value);
}

/**
 * Create an ISO date schema.
 * Accepts strings in format: 2023-12-15 or Date objects.
 * Date objects are automatically converted to ISO date strings (YYYY-MM-DD).
 *
 * @example
 * const birthDate = v.isoDate();
 * parse(birthDate, new Date()) // Returns "2023-12-15"
 */
export function isoDate<
  const Opts extends ScalarOptions<string, any> | undefined = undefined
>(
  options?: Opts
): IsoDateSchema<ComputeInput<string | Date, Opts>, ComputeOutput<string, Opts>> {
  return buildSchema("iso_date", validateIsoDate, options) as IsoDateSchema<
    ComputeInput<string | Date, Opts>,
    ComputeOutput<string, Opts>
  >;
}

// =============================================================================
// ISO Time Schema
// =============================================================================

export interface BaseIsoTimeSchema<
  Opts extends ScalarOptions<string, any> | undefined = undefined
> extends VibSchema<ComputeInput<string | Date, Opts>, ComputeOutput<string, Opts>> {}

export interface IsoTimeSchema<TInput = string | Date, TOutput = string>
  extends VibSchema<TInput, TOutput> {
  readonly type: "iso_time";
}

// Pre-computed errors
const INVALID_TIME_FORMAT = Object.freeze({
  issues: Object.freeze([
    Object.freeze({
      message: "Expected ISO time format (HH:mm:ss)",
    }),
  ]),
});
const INVALID_TIME = Object.freeze({
  issues: Object.freeze([Object.freeze({ message: "Invalid time" })]),
});

/**
 * Validate ISO time format.
 * Accepts Date objects and extracts the time portion (HH:mm:ss.sss).
 */
function validateIsoTime(value: unknown) {
  // Handle Date objects - extract time portion
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return INVALID_TIME;
    // Extract HH:mm:ss.sss from ISO string
    const isoString = value.toISOString();
    const timePart = isoString.split("T")[1]!.replace("Z", "");
    return ok(timePart);
  }

  if (typeof value !== "string") return NOT_STRING_OR_DATE_ERROR;
  if (!ISO_TIME_REGEX.test(value)) return INVALID_TIME_FORMAT;

  const parts = value.split(":").map(Number);
  const hours = parts[0] ?? 0;
  const minutes = parts[1] ?? 0;
  const seconds = parts[2] ?? 0;

  if (
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59 ||
    seconds < 0 ||
    seconds > 59
  ) {
    return INVALID_TIME;
  }
  return ok(value);
}

/**
 * Create an ISO time schema.
 * Accepts strings in format: 10:30:00 or Date objects.
 * Date objects are automatically converted to time strings (HH:mm:ss.sss).
 *
 * @example
 * const startTime = v.isoTime();
 * parse(startTime, new Date()) // Returns "10:30:00.000"
 */
export function isoTime<
  const Opts extends ScalarOptions<string, any> | undefined = undefined
>(
  options?: Opts
): IsoTimeSchema<ComputeInput<string | Date, Opts>, ComputeOutput<string, Opts>> {
  return buildSchema("iso_time", validateIsoTime, options) as IsoTimeSchema<
    ComputeInput<string | Date, Opts>,
    ComputeOutput<string, Opts>
  >;
}

// Export validators for reuse
export { validateIsoTimestamp, validateIsoDate, validateIsoTime };
