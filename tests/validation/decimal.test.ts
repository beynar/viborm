import v from "@validation/primitives/v";
import { describe, expect, test } from "vitest";

const parse = (value: unknown) =>
  v.decimal()["~standard"].validate(value) as
    | { value: string }
    | { issues: unknown[] };

const accepted = (value: unknown): string => {
  const result = parse(value);
  if ("issues" in result) {
    throw new Error(`expected ${String(value)} to be accepted`);
  }
  return result.value;
};

const refused = (value: unknown): boolean => "issues" in parse(value);

describe("decimal validation", () => {
  test("accepts exact decimal literals and keeps every digit", () => {
    expect(accepted("123.456")).toBe("123.456");
    expect(accepted("-0.0000000001")).toBe("-0.0000000001");
    // 30 fraction digits: the whole point of the type. A double keeps ~15.
    expect(accepted("0.123456789012345678901234567891")).toBe(
      "0.123456789012345678901234567891"
    );
    // A TRAILING zero is not a digit worth keeping — it is insignificant, and
    // dropping it is what makes "1.10" and "1.1" the same value everywhere.
    expect(accepted("0.123456789012345678901234567890")).toBe(
      "0.12345678901234567890123456789"
    );
    // Past 2^53, where a JS number stops being able to name consecutive integers
    expect(accepted("9007199254740993")).toBe("9007199254740993");
    expect(accepted("123456789012345678901234567890123456789")).toBe(
      "123456789012345678901234567890123456789"
    );
  });

  test("canonicalizes so one number has exactly one spelling", () => {
    expect(accepted("1.10")).toBe("1.1");
    expect(accepted("+1.5")).toBe("1.5");
    expect(accepted("007")).toBe("7");
    expect(accepted(".5")).toBe("0.5");
    expect(accepted("1.")).toBe("1");
    expect(accepted("0.000")).toBe("0");
    // Zero has no sign — otherwise SQLite's text equality would split -0 from 0
    expect(accepted("-0")).toBe("0");
    expect(accepted("-0.00")).toBe("0");
    expect(accepted("-01.2300")).toBe("-1.23");
  });

  test("equal numbers canonicalize to equal strings", () => {
    // This is the property SQLite's exact equality rests on
    expect(accepted("1.1")).toBe(accepted("1.10"));
    expect(accepted("0")).toBe(accepted("-0.0"));
    expect(accepted("100")).toBe(accepted("0100"));
  });

  test("refuses anything that does not name an exact decimal", () => {
    expect(refused("1e3")).toBe(true); // exponent form is a float spelling
    expect(refused("1E3")).toBe(true);
    expect(refused("0x10")).toBe(true);
    expect(refused("1.2.3")).toBe(true);
    expect(refused("1,5")).toBe(true);
    expect(refused(" 1.5")).toBe(true);
    expect(refused("1.5 ")).toBe(true);
    expect(refused("")).toBe(true);
    expect(refused(".")).toBe(true);
    expect(refused("-")).toBe(true);
    expect(refused("abc")).toBe(true);
    expect(refused("NaN")).toBe(true);
    expect(refused("Infinity")).toBe(true);
    expect(refused(Number.NaN)).toBe(true);
    expect(refused(Number.POSITIVE_INFINITY)).toBe(true);
    expect(refused(null)).toBe(true);
    expect(refused(true)).toBe(true);
    expect(refused({})).toBe(true);
  });

  test("accepts a number, and names the double it was actually given", () => {
    expect(accepted(1.5)).toBe("1.5");
    expect(accepted(-42)).toBe("-42");
    expect(accepted(0)).toBe("0");
    // The documented caveat, made explicit: a number operand carries whatever
    // float error the caller already made. We name the double faithfully rather
    // than launder it into a value the caller never had.
    expect(accepted(0.1 + 0.2)).toBe("0.30000000000000004");
  });

  test("expands the exponent form String(number) produces", () => {
    // String(1e21) is "1e+21" — plain digits are the only exact spelling
    expect(accepted(1e21)).toBe("1000000000000000000000");
    expect(accepted(1e-7)).toBe("0.0000001");
    expect(accepted(-1.5e-8)).toBe("-0.000000015");
    expect(accepted(1.2e22)).toBe("12000000000000000000000");
  });

  test("string and number spellings of the same value agree", () => {
    expect(accepted("1.5")).toBe(accepted(1.5));
    expect(accepted("0.0000001")).toBe(accepted(1e-7));
  });

  test("nullable and array options compose", () => {
    const nullable = v.decimal({ nullable: true })["~standard"].validate(null);
    expect(nullable).toEqual({ value: null });

    const list = v
      .decimal({ array: true })
      ["~standard"].validate(["1.10", 2, "-0"]);
    expect(list).toEqual({ value: ["1.1", "2", "0"] });

    const badList = v.decimal({ array: true })["~standard"].validate(["1e3"]);
    expect(badList).toHaveProperty("issues");
  });
});
