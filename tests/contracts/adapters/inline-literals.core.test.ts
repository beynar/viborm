/**
 * The literal renderer of a view body (`src/adapters/inline-literals.ts`):
 * each bound value written as a literal of its dialect, the text around it
 * untouched, the shared fragments left as they were. What each literal MEANS
 * on a real database is the differential suite's claim
 * (`inline-literals-behavior.ts`); these pin the spellings and the refusals.
 */

import { inlineLiterals } from "@adapters/inline-literals";
import { isVibORMError, VibORMErrorCode } from "@errors";
import { Sql, sql } from "@sql";
import { JsonParameter } from "@src/sql/json-parameter";
import { SqlSlot } from "@src/sql/slot";

const one = (dialect: "postgresql" | "mysql" | "sqlite", value: unknown) =>
  inlineLiterals(dialect, sql`${value}`);

/** The message and metadata of the V8003 refusal `run` throws; any other failure propagates. */
function refusal(run: () => unknown): { message: string; meta: unknown } {
  try {
    run();
  } catch (error) {
    if (
      !isVibORMError(error) ||
      error.code !== VibORMErrorCode.UNSUPPORTED_OPERATION
    )
      throw error;
    return { message: error.message, meta: error.meta };
  }
  throw new Error("expected a refusal");
}

const BYTES = new Uint8Array([0, 1, 0xab, 0xff]);
const JSON_VALUE = JsonParameter.from({ a: [1, "x'y"] });

describe("inlineLiterals: the text around the values", () => {
  test("interleaves every literal with the strings toStatement would place", () => {
    const statement = sql`SELECT ${sql`${1} + ${2}`} FROM t WHERE a = ${"x"} LIMIT ${3}`;
    expect(inlineLiterals("mysql", statement)).toBe(
      "SELECT 1 + 2 FROM t WHERE a = 'x' LIMIT 3"
    );
    expect(statement.toStatement("$n")).toBe(
      "SELECT $1 + $2 FROM t WHERE a = $3 LIMIT $4"
    );
  });

  test("a statement without values is its own text", () => {
    expect(inlineLiterals("sqlite", sql.raw("SELECT 1"))).toBe("SELECT 1");
  });

  test("reads a flattened statement, and flattens or caches nothing itself", () => {
    const inner = sql`a = ${"x"}`;
    const statement = sql`SELECT * FROM t WHERE ${inner}`;
    expect(inlineLiterals("postgresql", statement)).toBe(
      "SELECT * FROM t WHERE a = 'x'"
    );
    // Not flattened: the projection is still the raw tree's, made per call.
    expect(Sql.peek(statement)).not.toBe(Sql.peek(statement));
    expect(statement.toStatement("$n")).toBe("SELECT * FROM t WHERE a = $1");
    // Flattened by the driver's render: the same text from the kept projection.
    expect(inlineLiterals("postgresql", statement)).toBe(
      "SELECT * FROM t WHERE a = 'x'"
    );
  });

  test("an open slot reads as its provisional text, as toStatement would, and stays open", () => {
    const slot = new SqlSlot(sql`p = ${1}`);
    const statement = sql`SELECT * FROM t WHERE ${slot}`;
    expect(inlineLiterals("sqlite", statement)).toBe(
      "SELECT * FROM t WHERE p = 1.0"
    );
    slot.settle(sql`s = ${2}`);
    expect(inlineLiterals("sqlite", statement)).toBe(
      "SELECT * FROM t WHERE s = 2.0"
    );
  });
});

describe("inlineLiterals: PostgreSQL", () => {
  test("strings are untyped constants; a backslash makes an escape string", () => {
    expect(one("postgresql", "plain")).toBe("'plain'");
    expect(one("postgresql", "it's")).toBe("'it''s'");
    expect(one("postgresql", "a\\b'c")).toBe("E'a\\\\b''c'");
    expect(one("postgresql", "%_ 🦀")).toBe("'%_ 🦀'");
    expect(one("postgresql", "")).toBe("''");
  });

  test("a line break is written as an escape: no value breaks the statement's line", () => {
    expect(one("postgresql", "a\r\nb\\c")).toBe("E'a\\r\\nb\\\\c'");
  });

  test("numbers, bigints and booleans are their text, untyped, as node-postgres sends them", () => {
    expect(one("postgresql", 10)).toBe("'10'");
    expect(one("postgresql", -1.5)).toBe("'-1.5'");
    expect(one("postgresql", 2 ** 60)).toBe("'1152921504606847000'");
    expect(one("postgresql", 9_223_372_036_854_775_807n)).toBe(
      "'9223372036854775807'"
    );
    expect(one("postgresql", true)).toBe("'true'");
    expect(one("postgresql", false)).toBe("'false'");
  });

  test("null, bytes, a JSON carrier and a scalar array", () => {
    expect(one("postgresql", null)).toBe("NULL");
    expect(one("postgresql", BYTES)).toBe("E'\\\\x0001abff'::bytea");
    expect(one("postgresql", new Uint8Array())).toBe("E'\\\\x'::bytea");
    expect(one("postgresql", JSON_VALUE)).toBe(`'{"a":[1,"x''y"]}'`);
    expect(one("postgresql", ["a", 'q"', 1, 2n, true])).toBe(
      `E'{"a","q\\\\"","1","2","true"}'`
    );
    expect(one("postgresql", ["back\\slash"])).toBe(`E'{"back\\\\\\\\slash"}'`);
    expect(one("postgresql", [])).toBe("'{}'");
  });

  test("refuses NUL, a Date, an array of other members, an object, undefined", () => {
    expect(refusal(() => one("postgresql", "a\0b"))).toEqual({
      message:
        "A view body binds a string holding a NUL character, which a PostgreSQL string literal cannot hold.",
      meta: { dialect: "postgresql", feature: "view literal", type: "string" },
    });
    expect(refusal(() => one("postgresql", new Date(0))).meta).toEqual({
      dialect: "postgresql",
      feature: "view literal",
      type: "Date",
    });
    expect(refusal(() => one("postgresql", [null])).meta).toEqual({
      dialect: "postgresql",
      feature: "view literal",
      type: "array",
    });
    expect(refusal(() => one("postgresql", { a: 1 })).message).toBe(
      'A view body binds a value of kind "object", which has no PostgreSQL literal: no read of this dialect binds one.'
    );
    expect(refusal(() => one("postgresql", undefined)).meta).toEqual({
      dialect: "postgresql",
      feature: "view literal",
      type: "undefined",
    });
  });
});

describe("inlineLiterals: MySQL", () => {
  test("strings through the one MySQL string literal", () => {
    expect(one("mysql", "it's")).toBe("'it''s'");
    expect(one("mysql", "a\\b\n\r\0\u001a")).toBe("'a\\\\b\\n\\r\\0\\Z'");
  });

  test("a line break is written as an escape", () => {
    expect(one("mysql", "a\r\nb")).toBe("'a\\r\\nb'");
  });

  test("numbers and bigints bare, booleans, null and bytes", () => {
    expect(one("mysql", 10)).toBe("10");
    expect(one("mysql", -1.5)).toBe("-1.5");
    expect(one("mysql", 1e21)).toBe("1e+21");
    expect(one("mysql", -9_223_372_036_854_775_808n)).toBe(
      "-9223372036854775808"
    );
    expect(one("mysql", true)).toBe("TRUE");
    expect(one("mysql", false)).toBe("FALSE");
    expect(one("mysql", null)).toBe("NULL");
    expect(one("mysql", BYTES)).toBe("X'0001abff'");
  });

  test("refuses what no MySQL read binds: an array, a JSON carrier, a Date", () => {
    expect(refusal(() => one("mysql", ["a"])).meta).toEqual({
      dialect: "mysql",
      feature: "view literal",
      type: "array",
    });
    expect(refusal(() => one("mysql", JSON_VALUE)).message).toBe(
      'A view body binds a value of kind "JsonParameter", which has no MySQL literal: no read of this dialect binds one.'
    );
    expect(refusal(() => one("mysql", new Date(0))).meta).toEqual({
      dialect: "mysql",
      feature: "view literal",
      type: "Date",
    });
  });
});

describe("inlineLiterals: SQLite", () => {
  test("strings double their quotes and nothing else", () => {
    expect(one("sqlite", "it's \\ %_ 🦀")).toBe("'it''s \\ %_ 🦀'");
  });

  test("a line break is char(13) or char(10) between the string's parts", () => {
    expect(one("sqlite", "it's\r\nb\n")).toBe(
      "('it''s' || char(13) || char(10) || 'b' || char(10))"
    );
    expect(one("sqlite", "\n")).toBe("(char(10))");
  });

  test("a number is REAL, as the driver binds it; a negative one is parenthesized", () => {
    expect(one("sqlite", 10)).toBe("10.0");
    expect(one("sqlite", -0)).toBe("0.0");
    expect(one("sqlite", 1.5)).toBe("1.5");
    expect(one("sqlite", -3)).toBe("(-3.0)");
    expect(one("sqlite", 2 ** 60)).toBe("1152921504606847000.0");
    expect(one("sqlite", 1e21)).toBe("1e+21");
    expect(one("sqlite", -1e-7)).toBe("(-1e-7)");
    expect(inlineLiterals("sqlite", sql`5 -${-3}`)).toBe("5 -(-3.0)");
  });

  test("a bigint is INTEGER; a boolean is the REAL 1 or 0; null and bytes", () => {
    expect(one("sqlite", 9_007_199_254_740_993n)).toBe("9007199254740993");
    expect(one("sqlite", -42n)).toBe("(-42)");
    expect(one("sqlite", true)).toBe("1.0");
    expect(one("sqlite", false)).toBe("0.0");
    expect(one("sqlite", null)).toBe("NULL");
    expect(one("sqlite", BYTES)).toBe("X'0001abff'");
  });

  test("refuses NUL and what no SQLite read binds", () => {
    expect(refusal(() => one("sqlite", "a\0")).meta).toEqual({
      dialect: "sqlite",
      feature: "view literal",
      type: "string",
    });
    expect(refusal(() => one("sqlite", JSON_VALUE)).meta).toEqual({
      dialect: "sqlite",
      feature: "view literal",
      type: "JsonParameter",
    });
    expect(refusal(() => one("sqlite", [1])).meta).toEqual({
      dialect: "sqlite",
      feature: "view literal",
      type: "array",
    });
    expect(refusal(() => one("sqlite", () => 1)).meta).toEqual({
      dialect: "sqlite",
      feature: "view literal",
      type: "function",
    });
  });
});
