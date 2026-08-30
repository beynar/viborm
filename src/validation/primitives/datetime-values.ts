/**
 * The one logical instant domain of a VibORM DateTime value.
 *
 * Four-digit ISO years are not only an input spelling. They bound every
 * public DateTime instant, including a `Date` input and a provider value read
 * back through a numeric physical representation.
 */

export const MIN_DATETIME_EPOCH_MILLISECONDS = -62_167_219_200_000;
export const MAX_DATETIME_EPOCH_MILLISECONDS = 253_402_300_799_999;

/** Whether one number names a whole millisecond in the public DateTime domain. */
export function isDateTimeInstant(epochMilliseconds: number): boolean {
  return (
    Number.isInteger(epochMilliseconds) &&
    epochMilliseconds >= MIN_DATETIME_EPOCH_MILLISECONDS &&
    epochMilliseconds <= MAX_DATETIME_EPOCH_MILLISECONDS
  );
}

/** Whether three numeric components name one real proleptic-Gregorian date. */
export function isGregorianCalendarDate(
  year: number,
  month: number,
  day: number
): boolean {
  const hasIntegerComponents =
    Number.isInteger(year) && Number.isInteger(month) && Number.isInteger(day);
  if (!hasIntegerComponents || month < 1 || month > 12 || day < 1) {
    return false;
  }
  let daysInMonth = 31;
  if (month === 2) {
    daysInMonth = isLeapYear(year) ? 29 : 28;
  } else if (month === 4 || month === 6 || month === 9 || month === 11) {
    daysInMonth = 30;
  }
  return day <= daysInMonth;
}

/** Whether three numeric components name one clock time without leap seconds. */
export function isDateTimeClock(
  hour: number,
  minute: number,
  second: number
): boolean {
  return (
    Number.isInteger(hour) &&
    Number.isInteger(minute) &&
    Number.isInteger(second) &&
    hour >= 0 &&
    hour <= 23 &&
    minute >= 0 &&
    minute <= 59 &&
    second >= 0 &&
    second <= 59
  );
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}
