import {
  type DateTimeNumericForm,
  decodePhysicalDateTime,
  decodeProviderTimestamp,
  encodeMySqlDateTime,
  encodePhysicalDateTime,
  encodePostgresTemporal,
} from "@validation/primitives/datetime-physical-codec";
import {
  MAX_DATETIME_EPOCH_MILLISECONDS,
  MIN_DATETIME_EPOCH_MILLISECONDS,
} from "@validation/primitives/datetime-values";
import { describe, expect, test } from "vitest";

const INSTANT_ISO = "2024-01-15T10:30:00.000Z";
const INSTANT_MILLIS = 1_705_314_600_000;
const INSTANT_JULIAN = INSTANT_MILLIS / 86_400_000 + 2_440_587.5;

describe("datetime physical codec", () => {
  test("provider encoders retain ancient calendar years and millisecond precision", () => {
    expect(encodePostgresTemporal("0000-01-01T00:00:00.123Z")).toBe(
      "0001-01-01T00:00:00.123Z BC"
    );
    expect(encodePostgresTemporal(INSTANT_ISO)).toBe(INSTANT_ISO);
    expect(encodeMySqlDateTime("0099-01-01T00:00:00.123Z")).toBe(
      "0099-01-01 00:00:00.123"
    );
  });

  test.each([
    ["0001-01-01 00:00:00+00 BC", "0000-01-01T00:00:00.000Z"],
    ["0099-01-01 00:09:21+00:09:21", "0099-01-01T00:00:00.000Z"],
    ["2024-02-29 05:00:00.123456-02:30:15", "2024-02-29T07:30:15.123Z"],
    ["2024-02-29 05:00:00+0230", "2024-02-29T02:30:00.000Z"],
    ["2024-02-29T05:00:00Z", "2024-02-29T05:00:00.000Z"],
    ["2024-02-29 05:00:00", "2024-02-29T05:00:00.000Z"],
  ])("decodes provider timestamp %s independently of local time", (input, expected) => {
    expect(decodeProviderTimestamp(input)?.toISOString()).toBe(expected);
  });

  test.each([
    "not a timestamp",
    "2023-02-29 05:00:00",
    "2024-02-29 24:00:00",
    "2024-02-29 05:00:00+24:00",
    "2024-02-29 05:00:00+00:60",
    "2024-02-29 05:00:00+00:00:60",
    "0000-01-01 00:00:00+01",
    "9999-12-31 23:59:59-01",
  ])("refuses a provider timestamp outside the DateTime domain: %s", (input) => {
    expect(decodeProviderTimestamp(input)).toBeUndefined();
  });

  // The canonical `YYYY-MM-DDTHH:MM:SS.sssZ` spelling has its own reader; the
  // same instant spelled with a space separator takes the general grammar.
  // Both must agree on every value, admitted or refused.
  test.each([
    ["2024-01-15T10:30:00.123Z", "2024-01-15T10:30:00.123Z"],
    ["2024-02-29T23:59:59.999Z", "2024-02-29T23:59:59.999Z"],
    ["2000-02-29T00:00:00.000Z", "2000-02-29T00:00:00.000Z"],
    ["2023-02-29T00:00:00.000Z", undefined],
    ["1900-02-29T00:00:00.000Z", undefined],
    ["2024-02-30T00:00:00.000Z", undefined],
    ["2024-04-31T00:00:00.000Z", undefined],
    ["2024-13-01T00:00:00.000Z", undefined],
    ["2024-00-01T00:00:00.000Z", undefined],
    ["2024-01-00T00:00:00.000Z", undefined],
    ["2024-01-15T24:00:00.000Z", undefined],
    ["2024-01-15T23:60:00.000Z", undefined],
    ["2024-01-15T23:59:60.000Z", undefined],
    ["0099-12-31T23:59:59.999Z", "0099-12-31T23:59:59.999Z"],
    ["0100-01-01T00:00:00.000Z", "0100-01-01T00:00:00.000Z"],
    ["0000-01-01T00:00:00.000Z", "0000-01-01T00:00:00.000Z"],
    ["0004-02-29T12:00:00.000Z", "0004-02-29T12:00:00.000Z"],
    ["9999-12-31T23:59:59.999Z", "9999-12-31T23:59:59.999Z"],
    ["2024-0a-15T10:30:00.123Z", undefined],
    ["2024-01-15T10:30:00.12aZ", undefined],
    ["+024-01-15T10:30:00.123Z", undefined],
  ])("reads the canonical spelling %s as the general grammar does", (input, expected) => {
    expect(decodeProviderTimestamp(input)?.toISOString()).toBe(expected);
    expect(
      decodeProviderTimestamp(input.replace("T", " "))?.toISOString()
    ).toBe(expected);
  });

  test.each([
    ["2024-01-15T10:30:00Z", "2024-01-15T10:30:00.000Z"],
    ["2024-01-15T10:30:00.1Z", "2024-01-15T10:30:00.100Z"],
    ["2024-01-15T10:30:00.123456Z", "2024-01-15T10:30:00.123Z"],
    ["2024-01-15T10:30:00.123+01:00", "2024-01-15T09:30:00.123Z"],
    ["2024-01-15T10:30:00.123-0130", "2024-01-15T12:00:00.123Z"],
    ["2024-01-15T10:30:00.123", "2024-01-15T10:30:00.123Z"],
    ["0050-06-01T00:00:00.000+00", "0050-06-01T00:00:00.000Z"],
  ])("a near-canonical spelling %s still takes the general grammar", (input, expected) => {
    expect(decodeProviderTimestamp(input)?.toISOString()).toBe(expected);
  });

  describe("encodePhysicalDateTime", () => {
    test("text is the identity — the ISO string IS the physical value", () => {
      expect(encodePhysicalDateTime(INSTANT_ISO, "text")).toBe(INSTANT_ISO);
    });

    test("epochMillis is the exact millisecond count", () => {
      expect(encodePhysicalDateTime(INSTANT_ISO, "epochMillis")).toBe(
        INSTANT_MILLIS
      );
    });

    test("julianDay is the exact day arithmetic", () => {
      expect(encodePhysicalDateTime(INSTANT_ISO, "julianDay")).toBe(
        INSTANT_JULIAN
      );
    });

    test("Julian-day encoding is total across the public boundary instants", () => {
      for (const milliseconds of [
        MIN_DATETIME_EPOCH_MILLISECONDS,
        MAX_DATETIME_EPOCH_MILLISECONDS,
      ]) {
        const iso = new Date(milliseconds).toISOString();
        const physical = encodePhysicalDateTime(iso, "julianDay");
        expect(decodePhysicalDateTime(physical, "julianDay")?.getTime()).toBe(
          milliseconds
        );
      }
    });
  });

  describe("decodePhysicalDateTime", () => {
    test("reads an epoch-millisecond number back as the same instant", () => {
      expect(
        decodePhysicalDateTime(INSTANT_MILLIS, "epochMillis")?.toISOString()
      ).toBe(INSTANT_ISO);
    });

    test("reads a Julian day back to the nearest millisecond", () => {
      expect(
        decodePhysicalDateTime(INSTANT_JULIAN, "julianDay")?.toISOString()
      ).toBe(INSTANT_ISO);
    });

    test("round-trips the encode at both range boundaries", () => {
      for (const millis of [
        MIN_DATETIME_EPOCH_MILLISECONDS,
        MAX_DATETIME_EPOCH_MILLISECONDS,
        0,
      ]) {
        const iso = new Date(millis).toISOString();
        const forms: readonly DateTimeNumericForm[] = [
          "epochMillis",
          "julianDay",
        ];
        for (const form of forms) {
          const physical = encodePhysicalDateTime(iso, form);
          expect(decodePhysicalDateTime(physical, form)?.getTime()).toBe(
            millis
          );
        }
      }
    });

    test("admits a bigint INTEGER read and refuses one outside the DateTime domain", () => {
      expect(
        decodePhysicalDateTime(BigInt(INSTANT_MILLIS), "epochMillis")?.getTime()
      ).toBe(INSTANT_MILLIS);
      // Past 2^53 the round trip through number loses the value: refused, not
      // rounded into the public DateTime domain.
      expect(decodePhysicalDateTime(2n ** 63n, "epochMillis")).toBeUndefined();
    });

    test("refuses what the declared form cannot hold", () => {
      expect(
        decodePhysicalDateTime("not a number", "epochMillis")
      ).toBeUndefined();
      expect(decodePhysicalDateTime(Number.NaN, "epochMillis")).toBeUndefined();
      expect(
        decodePhysicalDateTime(Number.POSITIVE_INFINITY, "epochMillis")
      ).toBeUndefined();
      expect(decodePhysicalDateTime(0.5, "epochMillis")).toBeUndefined();
      expect(
        decodePhysicalDateTime(
          MIN_DATETIME_EPOCH_MILLISECONDS - 1,
          "epochMillis"
        )
      ).toBeUndefined();
      expect(
        decodePhysicalDateTime(
          MAX_DATETIME_EPOCH_MILLISECONDS + 1,
          "epochMillis"
        )
      ).toBeUndefined();
      // A day number outside the public domain is a malformed row, not an
      // extended-year Date.
      expect(decodePhysicalDateTime(1e12, "julianDay")).toBeUndefined();
    });
  });
});
