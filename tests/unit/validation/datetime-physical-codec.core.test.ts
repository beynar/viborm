import {
  decodePhysicalDateTime,
  encodePhysicalDateTime,
  numericDateTimeForm,
} from "@validation/primitives/datetime-physical-codec";
import { describe, expect, test } from "vitest";

const INSTANT_ISO = "2024-01-15T10:30:00.000Z";
const INSTANT_MILLIS = 1_705_314_600_000;
const INSTANT_JULIAN = INSTANT_MILLIS / 86_400_000 + 2_440_587.5;
const MAX_MILLIS = 8_640_000_000_000_000;

describe("datetime physical codec", () => {
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
      for (const millis of [MAX_MILLIS, -MAX_MILLIS, 0]) {
        const iso = new Date(millis).toISOString();
        for (const form of ["epochMillis", "julianDay"] as const) {
          const physical = encodePhysicalDateTime(iso, form);
          expect(decodePhysicalDateTime(physical, form)?.getTime()).toBe(
            millis
          );
        }
      }
    });

    test("admits a bigint INTEGER read and refuses one outside the calendar", () => {
      expect(
        decodePhysicalDateTime(BigInt(INSTANT_MILLIS), "epochMillis")?.getTime()
      ).toBe(INSTANT_MILLIS);
      // Past 2^53 the round trip through number loses the value: refused, not
      // rounded into the calendar.
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
        decodePhysicalDateTime(MAX_MILLIS + 1, "epochMillis")
      ).toBeUndefined();
      // A day number outside the calendar is a malformed row, not an invalid
      // Date.
      expect(decodePhysicalDateTime(1e12, "julianDay")).toBeUndefined();
    });
  });

  describe("numericDateTimeForm", () => {
    test("text and undeclared stay on the identical no-codec path", () => {
      expect(numericDateTimeForm(undefined)).toBeUndefined();
      expect(numericDateTimeForm("text")).toBeUndefined();
    });

    test("the two numeric forms pass through", () => {
      expect(numericDateTimeForm("epochMillis")).toBe("epochMillis");
      expect(numericDateTimeForm("julianDay")).toBe("julianDay");
    });
  });
});
