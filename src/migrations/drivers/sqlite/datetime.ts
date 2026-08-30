import type { DateTimePhysicalForm } from "@validation/primitives/datetime-physical-codec";
import {
  MAX_DATETIME_EPOCH_MILLISECONDS,
  MIN_DATETIME_EPOCH_MILLISECONDS,
} from "@validation/primitives/datetime-values";

const MILLISECONDS_PER_DAY = 86_400_000;
const UNIX_EPOCH_JULIAN_DAY = 2_440_587.5;
/** SQL literals mirroring the public four-digit UTC DateTime domain. */
const SQLITE_MIN_INTEGER = "-9223372036854775808";

const ISO_DATE = "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]";
const ISO_TIME = "[0-9][0-9]:[0-9][0-9]:[0-9][0-9]";
const ISO_OFFSET = "[+-][0-9][0-9]:[0-9][0-9]";
const ISO_TIMESTAMP_SHAPES = [
  `${ISO_DATE}T${ISO_TIME}Z`,
  `${ISO_DATE}T${ISO_TIME}.[0-9]Z`,
  `${ISO_DATE}T${ISO_TIME}.[0-9][0-9]Z`,
  `${ISO_DATE}T${ISO_TIME}.[0-9][0-9][0-9]Z`,
  `${ISO_DATE}T${ISO_TIME}${ISO_OFFSET}`,
  `${ISO_DATE}T${ISO_TIME}.[0-9]${ISO_OFFSET}`,
  `${ISO_DATE}T${ISO_TIME}.[0-9][0-9]${ISO_OFFSET}`,
  `${ISO_DATE}T${ISO_TIME}.[0-9][0-9][0-9]${ISO_OFFSET}`,
];

export function sqliteDateTimeTargetRequiresRecreation(
  from: DateTimePhysicalForm | undefined,
  to: DateTimePhysicalForm | undefined
): boolean {
  return to !== undefined && from !== to;
}

/** SQLite spelling of JavaScript's `Math.round`, including negative halves. */
function roundToInteger(expression: string): string {
  const integer = `CAST(${expression} AS INTEGER)`;
  const fraction = `(${expression} - ${integer})`;
  return (
    `(${integer} + CASE ` +
    `WHEN ${fraction} >= 0.5 THEN 1 ` +
    `WHEN ${fraction} < -0.5 THEN -1 ELSE 0 END)`
  );
}

function julianToEpochMilliseconds(julianDay: string): string {
  return roundToInteger(
    `((${julianDay} - ${UNIX_EPOCH_JULIAN_DAY}) * ${MILLISECONDS_PER_DAY})`
  );
}

function epochMillisecondsToJulian(epochMilliseconds: string): string {
  return (
    `((${epochMilliseconds} / ${MILLISECONDS_PER_DAY}.0) + ` +
    `${UNIX_EPOCH_JULIAN_DAY})`
  );
}

function textFractionMilliseconds(source: string): string {
  const first = `CAST(substr(${source}, 21, 1) AS INTEGER)`;
  const second = `CAST(substr(${source}, 22, 1) AS INTEGER)`;
  const third = `CAST(substr(${source}, 23, 1) AS INTEGER)`;
  return (
    `(CASE WHEN substr(${source}, 20, 1) <> '.' THEN 0 ELSE ` +
    `${first} * 100 + ` +
    `CASE WHEN substr(${source}, 22, 1) GLOB '[0-9]' THEN ${second} * 10 + ` +
    `CASE WHEN substr(${source}, 23, 1) GLOB '[0-9]' THEN ${third} ELSE 0 END ` +
    "ELSE 0 END END)"
  );
}

function textOffsetMilliseconds(source: string): string {
  const magnitude =
    `((CAST(substr(${source}, -5, 2) AS INTEGER) * 60 + ` +
    `CAST(substr(${source}, -2, 2) AS INTEGER)) * 60000)`;
  return (
    `(CASE WHEN substr(${source}, -1, 1) = 'Z' THEN 0 ` +
    `WHEN substr(${source}, -6, 1) = '+' THEN ${magnitude} ` +
    `ELSE -${magnitude} END)`
  );
}

/** Epoch milliseconds without SQLite's narrower timezone-offset parser. */
function textToEpochMilliseconds(source: string): string {
  const day = julianToEpochMilliseconds(
    `julianday(substr(${source}, 1, 10) || 'T00:00:00Z')`
  );
  const local =
    `(${day} + CAST(substr(${source}, 12, 2) AS INTEGER) * 3600000 + ` +
    `CAST(substr(${source}, 15, 2) AS INTEGER) * 60000 + ` +
    `CAST(substr(${source}, 18, 2) AS INTEGER) * 1000 + ` +
    `${textFractionMilliseconds(source)})`;
  return `(${local} - ${textOffsetMilliseconds(source)})`;
}

/** Canonical ISO text for an admitted SQLite-range epoch millisecond. */
function epochMillisecondsToText(epochMilliseconds: string): string {
  const wholeSeconds =
    `(CASE WHEN ${epochMilliseconds} < 0 AND ` +
    `${epochMilliseconds} % 1000 <> 0 ` +
    `THEN ${epochMilliseconds} / 1000 - 1 ` +
    `ELSE ${epochMilliseconds} / 1000 END)`;
  const milliseconds = `(((${epochMilliseconds} % 1000) + 1000) % 1000)`;
  return (
    "(" +
    `strftime('%Y-%m-%dT%H:%M:%S', ${wholeSeconds}, 'unixepoch') || ` +
    `printf('.%03dZ', ${milliseconds})` +
    ")"
  );
}

function epochMilliseconds(source: string, form: DateTimePhysicalForm): string {
  if (form === "epochMillis") return source;
  if (form === "julianDay") return julianToEpochMilliseconds(source);
  return textToEpochMilliseconds(source);
}

/** SQL transcription of `validateIsoTimestamp`'s accepted string grammar. */
function isIsoTimestamp(source: string): string {
  return `(${ISO_TIMESTAMP_SHAPES.map((shape) => `${source} GLOB '${shape}'`).join(" OR ")})`;
}

/** Component rules used by the public ISO timestamp admission boundary. */
function isAdmittedIsoTimestamp(source: string): string {
  const year = `CAST(substr(${source}, 1, 4) AS INTEGER)`;
  const month = `CAST(substr(${source}, 6, 2) AS INTEGER)`;
  const day = `CAST(substr(${source}, 9, 2) AS INTEGER)`;
  const hour = `CAST(substr(${source}, 12, 2) AS INTEGER)`;
  const minute = `CAST(substr(${source}, 15, 2) AS INTEGER)`;
  const second = `CAST(substr(${source}, 18, 2) AS INTEGER)`;
  const zulu = `substr(${source}, -1, 1) = 'Z'`;
  const offsetHour = `CAST(substr(${source}, -5, 2) AS INTEGER)`;
  const offsetMinute = `CAST(substr(${source}, -2, 2) AS INTEGER)`;
  const isLeapYear = `(${year} % 4 = 0 AND (${year} % 100 <> 0 OR ${year} % 400 = 0))`;
  const lastDay =
    `(CASE ${month} ` +
    `WHEN 2 THEN CASE WHEN ${isLeapYear} THEN 29 ELSE 28 END ` +
    "WHEN 4 THEN 30 WHEN 6 THEN 30 WHEN 9 THEN 30 WHEN 11 THEN 30 " +
    "ELSE 31 END)";
  return (
    `${isIsoTimestamp(source)} AND ${month} BETWEEN 1 AND 12 AND ` +
    `${day} BETWEEN 1 AND ${lastDay} AND ${hour} BETWEEN 0 AND 23 AND ` +
    `${minute} BETWEEN 0 AND 59 AND ${second} BETWEEN 0 AND 59 AND ` +
    `(${zulu} OR (${offsetHour} BETWEEN 0 AND 23 AND ${offsetMinute} BETWEEN 0 AND 59)) AND ` +
    `julianday(substr(${source}, 1, 10) || 'T00:00:00Z') IS NOT NULL`
  );
}

function sourceIsExact(
  source: string,
  form: DateTimePhysicalForm,
  epoch: string
): string {
  if (form === "text") {
    return (
      `typeof(${source}) = 'text' AND ${isAdmittedIsoTimestamp(source)} AND ` +
      `${epoch} BETWEEN ${MIN_DATETIME_EPOCH_MILLISECONDS} AND ${MAX_DATETIME_EPOCH_MILLISECONDS}`
    );
  }
  if (form === "epochMillis") {
    return (
      `typeof(${source}) = 'integer' AND ` +
      `${epoch} BETWEEN ${MIN_DATETIME_EPOCH_MILLISECONDS} AND ${MAX_DATETIME_EPOCH_MILLISECONDS}`
    );
  }
  return (
    `typeof(${source}) = 'real' AND ` +
    `${epoch} BETWEEN ${MIN_DATETIME_EPOCH_MILLISECONDS} AND ${MAX_DATETIME_EPOCH_MILLISECONDS} AND ` +
    `${epochMillisecondsToJulian(epoch)} = ${source}`
  );
}

function targetValue(epoch: string, form: DateTimePhysicalForm): string {
  if (form === "text") return epochMillisecondsToText(epoch);
  if (form === "epochMillis") return epoch;
  return epochMillisecondsToJulian(epoch);
}

function targetIsExact(
  epoch: string,
  form: DateTimePhysicalForm,
  value: string
): string {
  if (form === "text") {
    return `${value} IS NOT NULL AND ${isIsoTimestamp(value)}`;
  }
  if (form === "epochMillis") return "1";
  return `${julianToEpochMilliseconds(value)} = ${epoch}`;
}

/**
 * Converts one copied SQLite DateTime between its declared physical forms.
 *
 * The guard is the sole integrity boundary. It accepts only a value that is an
 * exact member of the source vocabulary and whose target representation
 * decodes to the same millisecond. `abs(INT64_MIN)` is SQLite's built-in,
 * deterministic error expression; it makes malformed, out-of-range, and
 * inexact rows abort the recreation instead of being rounded or reinterpreted.
 * An authenticated snapshot proves a same-form source and can retain it
 * unchanged. A live-introspected source has no logical marker, so even a
 * same-physical-form adoption crosses this guard before it becomes DateTime.
 */
export function sqliteDateTimeCopyExpression(
  source: string,
  from: DateTimePhysicalForm,
  to: DateTimePhysicalForm,
  isDeclaredSource: boolean
): string {
  if (from === to && isDeclaredSource) return source;
  const epoch = epochMilliseconds(source, from);
  const value = from === to ? source : targetValue(epoch, to);
  const exact =
    from === to
      ? sourceIsExact(source, from, epoch)
      : `${sourceIsExact(source, from, epoch)} AND ${targetIsExact(epoch, to, value)}`;
  return (
    `CASE WHEN ${source} IS NULL THEN NULL ` +
    `WHEN ${exact} THEN ${value} ` +
    `ELSE abs(${SQLITE_MIN_INTEGER}) END`
  );
}
