/**
 * Snowflake values cross the SQL API as text, both ways. These pin that every
 * crossing is exact: no integer past 2^53, no decimal digit, no nanosecond and
 * no time zone offset is lost on the way, and a `__proto__` column is a column.
 */

import {
  decodeRow,
  decodeValue,
  encodeBinding,
  encodeBindings,
} from "@drivers/snowflake/values";
import { describe, expect, it } from "vitest";

const column = (type: string, scale?: number) => ({
  name: "v",
  type,
  ...(scale === undefined ? {} : { scale }),
});

describe("Snowflake bindings", () => {
  it("binds each JavaScript value with its typed spelling", () => {
    expect(encodeBinding(null)).toEqual({ type: "TEXT", value: null });
    expect(encodeBinding(undefined)).toEqual({ type: "TEXT", value: null });
    expect(encodeBinding("a'b")).toEqual({ type: "TEXT", value: "a'b" });
    expect(encodeBinding(true)).toEqual({ type: "BOOLEAN", value: "true" });
    expect(encodeBinding(42)).toEqual({ type: "FIXED", value: "42" });
    expect(encodeBinding(-0.1)).toEqual({ type: "REAL", value: "-0.1" });
    expect(encodeBinding(12_345_678_901_234_567_890n)).toEqual({
      type: "FIXED",
      value: "12345678901234567890",
    });
    expect(encodeBinding(new Uint8Array([0, 15, 255]))).toEqual({
      type: "BINARY",
      value: "000fff",
    });
    expect(encodeBinding({ a: [1, 2n] })).toEqual({
      type: "TEXT",
      value: '{"a":[1,"2"]}',
    });
  });

  it("binds an integral double past 2^53 as its exact digits, not 1e+21", () => {
    expect(encodeBinding(1e21)).toEqual({
      type: "FIXED",
      value: "1000000000000000000000",
    });
  });

  it("binds an integer past NUMBER's 38 digits as its double, and a non-finite double as the text Snowflake reads", () => {
    expect(encodeBinding(1e40)).toEqual({ type: "REAL", value: "1e+40" });
    expect(encodeBinding(-1e38)).toEqual({ type: "REAL", value: "-1e+38" });
    // Snowflake refuses a REAL "inf" (measured), and reads the text as FLOAT.
    expect(encodeBinding(Number.POSITIVE_INFINITY)).toEqual({
      type: "TEXT",
      value: "inf",
    });
    expect(encodeBinding(Number.NEGATIVE_INFINITY)).toEqual({
      type: "TEXT",
      value: "-inf",
    });
    expect(encodeBinding(Number.NaN)).toEqual({ type: "TEXT", value: "NaN" });
  });

  it("binds a Date as a UTC TIMESTAMP_TZ in nanoseconds", () => {
    expect(encodeBinding(new Date("2024-01-02T03:04:05.678Z"))).toEqual({
      type: "TIMESTAMP_TZ",
      value: "1704164645678000000 1440",
    });
    expect(encodeBinding(new Date("1969-12-31T23:59:59.999Z"))).toEqual({
      type: "TIMESTAMP_TZ",
      value: "-1000000 1440",
    });
  });

  it("numbers the bindings as the ? placeholders count, and binds none for none", () => {
    expect(encodeBindings([])).toBeUndefined();
    expect(encodeBindings(["a", 1])).toEqual({
      "1": { type: "TEXT", value: "a" },
      "2": { type: "FIXED", value: "1" },
    });
  });

  it("refuses an invalid Date and a function", () => {
    expect(() => encodeBinding(new Date(Number.NaN))).toThrow(
      "An invalid Date cannot be bound."
    );
    expect(() => encodeBinding(() => 1)).toThrow("cannot be bound");
  });
});

describe("Snowflake answers", () => {
  it("reads a NUMBER(p,0) as a number while it is a safe integer, else a bigint", () => {
    expect(decodeValue(column("fixed", 0), "9007199254740991")).toBe(
      9_007_199_254_740_991
    );
    expect(decodeValue(column("fixed", 0), "9007199254740993")).toBe(
      9_007_199_254_740_993n
    );
    expect(decodeValue(column("fixed", 0), "-12")).toBe(-12);
  });

  it("keeps a NUMBER(p,s) as its exact decimal text", () => {
    expect(decodeValue(column("fixed", 2), "12345678901234567890.10")).toBe(
      "12345678901234567890.10"
    );
  });

  it("reads FLOAT, BOOLEAN and the non-finite doubles", () => {
    expect(decodeValue(column("real"), "1.5")).toBe(1.5);
    expect(decodeValue(column("real"), "inf")).toBe(Number.POSITIVE_INFINITY);
    expect(decodeValue(column("real"), "-inf")).toBe(Number.NEGATIVE_INFINITY);
    expect(decodeValue(column("real"), "NaN")).toBeNaN();
    expect(decodeValue(column("boolean"), "true")).toBe(true);
    expect(decodeValue(column("boolean"), "false")).toBe(false);
  });

  it("reads DATE from days since the epoch and TIME from seconds since midnight", () => {
    expect(decodeValue(column("date"), "18262")).toBe("2020-01-01");
    expect(decodeValue(column("date"), "-1")).toBe("1969-12-31");
    expect(decodeValue(column("time"), "82919.123456789")).toBe(
      "23:01:59.123456789"
    );
  });

  it("reads TIMESTAMP_NTZ and _LTZ to the nanosecond, before the epoch too", () => {
    expect(decodeValue(column("timestamp_ntz"), "1704164645.678901234")).toBe(
      "2024-01-02T03:04:05.678901234Z"
    );
    expect(decodeValue(column("timestamp_ltz"), "-0.000000001")).toBe(
      "1969-12-31T23:59:59.999999999Z"
    );
  });

  it("reads TIMESTAMP_TZ at its own offset (minutes + 1440)", () => {
    // 1616173619 is 2021-03-19T17:06:59Z; 960 is -08:00.
    expect(
      decodeValue(column("timestamp_tz"), "1616173619.000000000 960")
    ).toBe("2021-03-19T09:06:59.000000000-08:00");
    expect(
      decodeValue(column("timestamp_tz"), "1616173619.500000000 1770")
    ).toBe("2021-03-19T22:36:59.500000000+05:30");
  });

  it("reads BINARY as bytes and semi-structured values as their JSON", () => {
    expect(decodeValue(column("binary"), "00ff10")).toEqual(
      new Uint8Array([0, 255, 16])
    );
    expect(decodeValue(column("variant"), '{"a":[1,null]}')).toEqual({
      a: [1, null],
    });
    expect(decodeValue(column("array"), "[]")).toEqual([]);
    // Snowflake prints a SQL NULL inside an array as `undefined` (measured).
    expect(decodeValue(column("array"), "[\n  1,\n  undefined\n]")).toEqual([
      1,
      null,
    ]);
    expect(
      decodeValue(
        column("variant"),
        '{"a":["undefined","x\\" undefined"],"b":undefined}'
      )
    ).toEqual({ a: ["undefined", 'x" undefined'], b: null });
    expect(decodeValue(column("object"), '"text"')).toBe("text");
  });

  it("reads a non-finite double inside a VARIANT as the string STRICT_JSON_OUTPUT prints", () => {
    expect(
      decodeValue(
        column("object"),
        '{"a": NaN, "b": [1, Infinity, -Infinity, undefined], "c": "NaN Infinity undefined"}'
      )
    ).toEqual({
      a: "NaN",
      b: [1, "Infinity", "-Infinity", null],
      c: "NaN Infinity undefined",
    });
    expect(decodeValue(column("variant"), "NaN")).toBe("NaN");
    // What an account with STRICT_JSON_OUTPUT prints reads the same.
    expect(decodeValue(column("object"), '{"a": "NaN"}')).toEqual({ a: "NaN" });
  });

  it("refuses a timestamp past JavaScript's dates rather than spelling NaN", () => {
    expect(() =>
      decodeValue(column("timestamp_tz"), "1616173619000000000 960")
    ).toThrow("cannot read");
    expect(() =>
      decodeValue(column("timestamp_ntz"), "9000000000000000.000000000")
    ).toThrow("cannot read");
  });

  it("answers null for NULL and the text for a type it does not know", () => {
    expect(decodeValue(column("fixed", 0), null)).toBeNull();
    expect(decodeValue(column("geography"), "POINT(1 2)")).toBe("POINT(1 2)");
  });

  it("refuses an answer its column type cannot hold", () => {
    expect(() => decodeValue(column("fixed", 0), "1.5")).toThrow(
      "Snowflake answered a NUMBER value"
    );
    expect(() => decodeValue(column("binary"), "0g")).toThrow("BINARY");
    expect(() => decodeValue(column("variant"), "{")).toThrow("VARIANT");
  });

  it("keys a row by its columns, a __proto__ column included", () => {
    const row = decodeRow<Record<string, unknown>>(
      [
        { name: "id", type: "fixed", scale: 0 },
        { name: "__proto__", type: "text" },
      ],
      ["1", "x"]
    );
    expect(Object.keys(row)).toEqual(["id", "__proto__"]);
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
    expect(row.id).toBe(1);
  });
});
