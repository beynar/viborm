/**
 * The ONE physical datetime codec.
 *
 * A datetime's LOGICAL value is an instant, and every layer above this one
 * spells it as a validated ISO-8601 string or a `Date`. Its PHYSICAL value is
 * whatever the column it lands in actually holds, and SQLite makes that a
 * DECLARED choice with three answers: timestamp TEXT, an INTEGER count of epoch
 * milliseconds, or a REAL Julian day. This module owns the conversion between
 * the two, so value lowering and result decoding cannot disagree about what a
 * column holds.
 *
 * The form is declared and never inferred, because a physical value cannot name
 * its own vocabulary: `2460324.9375` is 2024-01-15T10:30:00Z as a Julian day and
 * an instant in 1970 as milliseconds, and `1705314600000` is that same instant
 * as milliseconds and a date no calendar reaches as a Julian day.
 */

import { isBigInt, isNumber } from "../value-guards";

/**
 * The three physical spellings a datetime column can hold.
 *
 * `text` is the timestamp text every dialect stores by default, and its
 * conversion is the identity — the ISO string IS the physical value. The other
 * two are numbers, and each has an exact arithmetic.
 */
export type DateTimePhysicalForm = "text" | "epochMillis" | "julianDay";

/**
 * The two forms whose physical value is a NUMBER rather than timestamp text.
 *
 * Named separately because the decode entry accepts only these: the textual
 * grammar a provider timestamp is held to belongs to the result boundary that
 * already owns it for every dialect, and duplicating it here would give one
 * spelling two readers.
 */
export type DateTimeNumericForm = Exclude<DateTimePhysicalForm, "text">;

const MILLISECONDS_PER_DAY = 86_400_000;

/** The Julian day of 1970-01-01T00:00:00Z, where the Unix epoch begins. */
const UNIX_EPOCH_JULIAN_DAY = 2_440_587.5;

/** The widest instant a JavaScript `Date` represents, in either direction. */
const MAX_EPOCH_MILLISECONDS = 8_640_000_000_000_000;

/**
 * Whether a number names one exact instant: a whole millisecond inside the
 * representable range. `NaN` and the infinities fail on the integer test, so
 * finiteness needs no second check.
 */
function isExactInstant(epochMilliseconds: number): boolean {
  return (
    Number.isInteger(epochMilliseconds) &&
    Math.abs(epochMilliseconds) <= MAX_EPOCH_MILLISECONDS
  );
}

/**
 * The number a provider returned for a numeric datetime column, or `undefined`
 * when it returned something else.
 *
 * `bigint` is admitted because the SQLite family reads INTEGER columns in a
 * BigInt mode so values past 2^53 survive — an epoch-millisecond column is read
 * through that same mode. Every representable instant is a SAFE integer
 * (8.64e15 < 2^53), so a bigint that does not survive the round trip is already
 * outside the calendar and is refused here rather than rounded into it.
 */
function physicalNumber(value: unknown): number | undefined {
  if (isNumber(value)) return Number.isFinite(value) ? value : undefined;
  if (isBigInt(value)) {
    // `Number(bigint)` is exact for every magnitude below 2^53, so the safe
    // test alone decides survival — an unsafe result is already outside the
    // calendar and there is no second case to check.
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : undefined;
  }
  return undefined;
}

/**
 * The physical value one VALIDATED ISO-8601 timestamp lands in a column as.
 *
 * Total for its precondition, like `encodePhysicalDecimal`: the ISO boundary
 * (`validateIsoTimestamp`) already owns "this string names an instant", and
 * every value lowered here has crossed it. Behavior on any other string is
 * unspecified rather than re-guarded — one guard per invariant.
 */
export function encodePhysicalDateTime(
  iso: string,
  form: DateTimePhysicalForm
): string | number {
  if (form === "text") return iso;
  const epochMilliseconds = Date.parse(iso);
  return form === "epochMillis"
    ? epochMilliseconds
    : epochMilliseconds / MILLISECONDS_PER_DAY + UNIX_EPOCH_JULIAN_DAY;
}

/**
 * The instant one physical number holds, or `undefined` when the provider
 * returned a value this column's declared form cannot hold.
 *
 * A Julian day is a COUNT OF DAYS in a double, so its resolution near the
 * present is about fifty microseconds and a millisecond is not exactly
 * representable in it. The instant is therefore rounded to the nearest
 * millisecond — the same precision the logical value has — and then held to the
 * representable range, so a day number outside the calendar is a malformed row
 * rather than an invalid `Date`.
 */
export function decodePhysicalDateTime(
  value: unknown,
  form: DateTimeNumericForm
): Date | undefined {
  const physical = physicalNumber(value);
  if (physical === undefined) return undefined;
  const epochMilliseconds =
    form === "epochMillis"
      ? physical
      : Math.round((physical - UNIX_EPOCH_JULIAN_DAY) * MILLISECONDS_PER_DAY);
  if (!isExactInstant(epochMilliseconds)) return undefined;
  return new Date(epochMilliseconds);
}

/**
 * The numeric form of a declared physical spelling, or `undefined` when the
 * column holds timestamp text and there is no re-interpretation to do.
 *
 * The one narrowing between "which of the three forms did the schema declare"
 * and "does the result boundary have to read this column through the codec",
 * so an undeclared field and a TEXT-declared one stay on the identical path.
 */
export function numericDateTimeForm(
  form: DateTimePhysicalForm | undefined
): DateTimeNumericForm | undefined {
  return form === undefined || form === "text" ? undefined : form;
}
