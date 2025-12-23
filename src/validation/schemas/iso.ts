import { inferred } from "../inferred";
import type {
  VibSchema,
  ScalarOptions,
  ComputeInput,
  ComputeOutput,
} from "../types";
import { applyOptions, fail, ok, createSchema } from "../helpers";

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

// =============================================================================
// ISO Timestamp Schema
// =============================================================================

export interface IsoTimestampSchema<TInput = string, TOutput = string>
  extends VibSchema<TInput, TOutput> {
  readonly type: "iso_timestamp";
}

/**
 * Validate ISO timestamp format.
 */
function validateIsoTimestamp(value: unknown) {
  if (typeof value !== "string") {
    return fail(`Expected ISO timestamp string, received ${typeof value}`);
  }
  if (!ISO_TIMESTAMP_REGEX.test(value)) {
    return fail(
      `Expected ISO timestamp format (YYYY-MM-DDTHH:mm:ss.sssZ), received "${value}"`
    );
  }
  // Validate it's a real date
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return fail(`Invalid date in ISO timestamp: ${value}`);
  }
  return ok(value);
}

/**
 * Create an ISO timestamp schema.
 * Validates strings in format: 2023-12-15T10:30:00.000Z
 *
 * @example
 * const timestamp = v.isoTimestamp();
 */
export function isoTimestamp<
  const Opts extends ScalarOptions<string, any> | undefined = undefined
>(
  options?: Opts
): IsoTimestampSchema<ComputeInput<string, Opts>, ComputeOutput<string, Opts>> {
  return createSchema("iso_timestamp", (value) =>
    applyOptions(value, validateIsoTimestamp, options, "ISO timestamp")
  ) as IsoTimestampSchema<
    ComputeInput<string, Opts>,
    ComputeOutput<string, Opts>
  >;
}

// =============================================================================
// ISO Date Schema
// =============================================================================

export interface IsoDateSchema<TInput = string, TOutput = string>
  extends VibSchema<TInput, TOutput> {
  readonly type: "iso_date";
}

/**
 * Validate ISO date format.
 */
function validateIsoDate(value: unknown) {
  if (typeof value !== "string") {
    return fail(`Expected ISO date string, received ${typeof value}`);
  }
  if (!ISO_DATE_REGEX.test(value)) {
    return fail(`Expected ISO date format (YYYY-MM-DD), received "${value}"`);
  }
  // Validate it's a real date
  const date = new Date(value + "T00:00:00Z");
  if (Number.isNaN(date.getTime())) {
    return fail(`Invalid date: ${value}`);
  }
  return ok(value);
}

/**
 * Create an ISO date schema.
 * Validates strings in format: 2023-12-15
 *
 * @example
 * const birthDate = v.isoDate();
 */
export function isoDate<
  const Opts extends ScalarOptions<string, any> | undefined = undefined
>(
  options?: Opts
): IsoDateSchema<ComputeInput<string, Opts>, ComputeOutput<string, Opts>> {
  return createSchema("iso_date", (value) =>
    applyOptions(value, validateIsoDate, options, "ISO date")
  ) as IsoDateSchema<ComputeInput<string, Opts>, ComputeOutput<string, Opts>>;
}

// =============================================================================
// ISO Time Schema
// =============================================================================

export interface IsoTimeSchema<TInput = string, TOutput = string>
  extends VibSchema<TInput, TOutput> {
  readonly type: "iso_time";
}

/**
 * Validate ISO time format.
 */
function validateIsoTime(value: unknown) {
  if (typeof value !== "string") {
    return fail(`Expected ISO time string, received ${typeof value}`);
  }
  if (!ISO_TIME_REGEX.test(value)) {
    return fail(`Expected ISO time format (HH:mm:ss), received "${value}"`);
  }
  // Validate time components are valid
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
    return fail(`Invalid time: ${value}`);
  }
  return ok(value);
}

/**
 * Create an ISO time schema.
 * Validates strings in format: 10:30:00
 *
 * @example
 * const startTime = v.isoTime();
 */
export function isoTime<
  const Opts extends ScalarOptions<string, any> | undefined = undefined
>(
  options?: Opts
): IsoTimeSchema<ComputeInput<string, Opts>, ComputeOutput<string, Opts>> {
  return createSchema("iso_time", (value) =>
    applyOptions(value, validateIsoTime, options, "ISO time")
  ) as IsoTimeSchema<ComputeInput<string, Opts>, ComputeOutput<string, Opts>>;
}

// Export validators for reuse
export { validateIsoTimestamp, validateIsoDate, validateIsoTime };
