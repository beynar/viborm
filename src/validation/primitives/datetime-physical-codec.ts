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
import {
  isDateTimeClock,
  isDateTimeInstant,
  isGregorianCalendarDate,
} from "./datetime-values";

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

/** PostgreSQL uses historical years: the admitted ISO year 0000 is 1 BC. */
export function encodePostgresTemporal(iso: string): string {
  return iso.startsWith("0000-") ? `0001${iso.slice(4)} BC` : iso;
}

/**
 * The number a provider returned for a numeric datetime column, or `undefined`
 * when it returned something else.
 *
 * `bigint` is admitted because the SQLite family reads INTEGER columns in a
 * BigInt mode so values past 2^53 survive — an epoch-millisecond column is read
 * through that same mode. Every public DateTime instant is a safe integer, so a
 * bigint that does not survive the round trip is already outside the domain and
 * is refused here rather than rounded into it.
 */
function physicalNumber(value: unknown): number | undefined {
  if (isNumber(value)) return Number.isFinite(value) ? value : undefined;
  if (isBigInt(value)) {
    // `Number(bigint)` is exact for every magnitude below 2^53, so the safe
    // test alone decides survival — an unsafe result is already outside the
    // public DateTime domain and there is no second case to check.
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : undefined;
  }
  return undefined;
}

/**
 * The physical value one VALIDATED ISO-8601 timestamp lands in a column as.
 *
 * The ISO boundary (`validateIsoTimestamp`) already owns "this string names an
 * instant", and every value lowered here has crossed it. REAL/Julian storage
 * needs no second admission branch: every millisecond in the four-digit public
 * DateTime domain survives its Julian-day double round trip. Behavior on any
 * other string is unspecified rather than re-guarded — one guard per invariant.
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
 * public four-digit instant range, so a day number outside the DateTime domain
 * is a malformed row rather than an extended-year `Date`.
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
  if (!isDateTimeInstant(epochMilliseconds)) return undefined;
  return new Date(epochMilliseconds);
}

const TIMESTAMP_TEXT =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(?:(Z)|([+-])(\d{2})(?::?(\d{2}))?(?::?(\d{2}))?)?(?: (BC))?$/;

/** The digits `value` holds at `[at, at + count)`, or -1 where one is not a digit. */
function digitsAt(value: string, at: number, count: number): number {
  let parsed = 0;
  for (let index = at; index < at + count; index += 1) {
    const digit = value.charCodeAt(index) - 48;
    if (digit < 0 || digit > 9) return -1;
    parsed = parsed * 10 + digit;
  }
  return parsed;
}

/**
 * The canonical stored spelling `YYYY-MM-DDTHH:MM:SS.sssZ` (what the
 * DateTime boundary writes), read by character: `false` for any other
 * spelling, and for a year below 100, which `Date.UTC` would read as 19xx.
 * The general grammar reads both; the domain rules are the same.
 */
function decodeCanonicalTimestamp(value: string): Date | undefined | false {
  if (
    value.length !== 24 ||
    value.charCodeAt(4) !== 45 || // -
    value.charCodeAt(7) !== 45 || // -
    value.charCodeAt(10) !== 84 || // T
    value.charCodeAt(13) !== 58 || // :
    value.charCodeAt(16) !== 58 || // :
    value.charCodeAt(19) !== 46 || // .
    value.charCodeAt(23) !== 90 // Z
  )
    return false;
  const year = digitsAt(value, 0, 4);
  const month = digitsAt(value, 5, 2);
  const day = digitsAt(value, 8, 2);
  const hour = digitsAt(value, 11, 2);
  const minute = digitsAt(value, 14, 2);
  const second = digitsAt(value, 17, 2);
  const millisecond = digitsAt(value, 20, 3);
  if (
    year < 100 ||
    month < 0 ||
    day < 0 ||
    hour < 0 ||
    minute < 0 ||
    second < 0 ||
    millisecond < 0
  )
    return false;
  if (
    !(
      isGregorianCalendarDate(year, month, day) &&
      isDateTimeClock(hour, minute, second)
    )
  )
    return undefined;
  const epoch = Date.UTC(
    year,
    month - 1,
    day,
    hour,
    minute,
    second,
    millisecond
  );
  return isDateTimeInstant(epoch) ? new Date(epoch) : undefined;
}

/** The provider timestamp grammar; the domain rules are the codec's. */
export function decodeProviderTimestamp(value: string): Date | undefined {
  const canonical = decodeCanonicalTimestamp(value);
  if (canonical !== false) return canonical;
  const match = TIMESTAMP_TEXT.exec(value);
  if (!match) return undefined;
  const year = match[13] ? 1 - Number(match[1]) : Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = Number(match[10] ?? 0);
  const offsetMinute = Number(match[11] ?? 0);
  const offsetSecond = Number(match[12] ?? 0);
  if (
    !(
      isGregorianCalendarDate(year, month, day) &&
      isDateTimeClock(hour, minute, second)
    ) ||
    offsetHour > 23 ||
    offsetMinute > 59 ||
    offsetSecond > 59
  )
    return undefined;
  const parsed = new Date(0);
  // setUTCFullYear keeps years 0..99 literal; Date.UTC reinterprets them as 1900..1999.
  parsed.setUTCFullYear(year, month - 1, day);
  parsed.setUTCHours(
    hour,
    minute,
    second,
    Number((match[7] ?? "").padEnd(3, "0").slice(0, 3))
  );
  const offset = (offsetHour * 3600 + offsetMinute * 60 + offsetSecond) * 1000;
  const epoch = parsed.getTime() - (match[9] === "-" ? -offset : offset);
  return isDateTimeInstant(epoch) ? new Date(epoch) : undefined;
}

/** MySQL DATETIME stores the admitted instant as a naive UTC wall clock. */
export const encodeMySqlDateTime = (iso: string): string =>
  new Date(iso).toISOString().slice(0, 23).replace("T", " ");
