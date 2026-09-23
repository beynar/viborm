import { Decimal } from "@src/index";
import {
  admitDecimal,
  canonicalDecimalText,
  DECIMAL_CONSTRUCTOR_REFUSAL,
  fromCanonical,
} from "@validation/primitives/decimal-value";
import { describe, expect, test } from "vitest";

/**
 * The exact decimal VALUE type, on its own.
 *
 * `decimal.core.test.ts` next door owns the FIELD: admission through
 * `v.decimal()`, descriptors, provider vocabularies, DDL. This file owns the
 * value: what the constructor accepts and refuses, what each operation answers,
 * and the three properties everything above it rests on — canonical text is the
 * representation rather than a rendering of it, an instance carries no state a
 * caller can reach, and construction is the only way into the family.
 *
 * Every expected answer below was executed against `big.js@7.0.1`, the value
 * type this one replaces, before it was written down: the same 16 spellings
 * and the same operand pairs across plus, minus, times, div, cmp, toFixed and
 * toNumber. The migration is a dependency change, not an
 * arithmetic change.
 */

describe("decimal value: what it accepts", () => {
  test("canonicalizes every accepted spelling to exactly one text", () => {
    for (const [input, canonical] of [
      ["0", "0"],
      ["-0", "0"],
      ["+0", "0"],
      ["0.0", "0"],
      ["-0.000", "0"],
      ["1", "1"],
      ["1.10", "1.1"],
      ["1.1", "1.1"],
      [".5", "0.5"],
      ["-.5", "-0.5"],
      ["1.", "1"],
      ["+00012.3400", "12.34"],
      ["-000.500", "-0.5"],
      ["0.0000000001", "0.0000000001"],
      ["-9", "-9"],
      [
        "123456789012345678901234567890.000123",
        "123456789012345678901234567890.000123",
      ],
    ] as const) {
      expect(new Decimal(input).toString()).toBe(canonical);
    }
  });

  test("refuses every JavaScript number, whatever double it names", () => {
    // A double is not an exact decimal: each of these used to be spelled
    // through `String(n)` and admitted. Integral, fractional, exponent-form and
    // zero doubles are all refused with the one constructor sentence.
    for (const input of [
      0,
      -0,
      7,
      -12.345,
      1e21,
      -1e21,
      1e-7,
      0.1 + 0.2,
      1_234_567_890_123,
      5e-324,
      Number.MAX_VALUE,
    ]) {
      expect(() => new Decimal(input as never)).toThrow(
        DECIMAL_CONSTRUCTOR_REFUSAL
      );
    }
  });

  test("admits a whole bigint as the integer it names", () => {
    for (const [input, canonical] of [
      [0n, "0"],
      [5n, "5"],
      [-5n, "-5"],
      [100n, "100"],
      [
        123_456_789_012_345_678_901_234_567_890n,
        "123456789012345678901234567890",
      ],
    ] as const) {
      expect(new Decimal(input).toString()).toBe(canonical);
    }
    expect(new Decimal("1.5").plus(2n).toString()).toBe("3.5");
  });

  test("copies another Decimal without re-reading any spelling", () => {
    const source = new Decimal("-12.340");
    const copy = new Decimal(source);
    expect(copy).not.toBe(source);
    expect(copy.toString()).toBe("-12.34");
    expect(copy.eq(source)).toBe(true);
  });

  test("refuses everything that does not name an exact finite decimal", () => {
    for (const bad of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      "1e3",
      "abc",
      "",
      ".",
      " 1 ",
      "1,5",
      null,
      undefined,
      {},
      [],
      true,
      Object.create(Decimal.prototype),
    ]) {
      expect(() => new Decimal(bad as never)).toThrow(TypeError);
    }
    expect(() => new Decimal("x" as never)).toThrow(
      "Expected an exact decimal: a Decimal, a bigint, or a string like '-12.345' (sign, digits, at most one dot, no exponent); a JavaScript number is a double and is not accepted"
    );
  });

  test("admits the same values the field boundary does", () => {
    // One admission rule, two readers: the constructor throws where
    // `admitDecimal` answers `undefined`, and they never disagree
    // about which spellings are in.
    for (const input of [
      "1.50",
      ".5",
      "1.",
      "+2",
      "-0",
      "0.0000001",
      new Decimal("-3.50"),
    ]) {
      expect(admitDecimal(input)).toBe(new Decimal(input).toString());
    }
    for (const input of [
      "1e3",
      "abc",
      "",
      "NaN",
      1.5,
      Object.create(Decimal.prototype),
      new Proxy(new Decimal("1"), {}),
      { s: 1, e: 0, c: [1] },
    ]) {
      expect(admitDecimal(input)).toBeUndefined();
      expect(() => new Decimal(input)).toThrow(DECIMAL_CONSTRUCTOR_REFUSAL);
    }
  });
});

describe("decimal value: arithmetic", () => {
  const OPERANDS = [
    "0",
    "1",
    "-1",
    "0.5",
    "-0.5",
    "2.25",
    "-3.125",
    "1000000",
    "0.0001",
    "7.5",
  ] as const;

  test("adds, subtracts and multiplies exactly at the wider scale", () => {
    expect(new Decimal("0.1").plus("0.2").toString()).toBe("0.3");
    expect(new Decimal("1.005").minus("0.005").toString()).toBe("1");
    expect(new Decimal("2.5").times("4").toString()).toBe("10");
    expect(new Decimal("-3.125").times("0.0001").toString()).toBe("-0.0003125");
    expect(new Decimal("1000000").plus("0.0001").toString()).toBe(
      "1000000.0001"
    );
    // A binary operand crosses the same admission grammar the constructor does.
    expect(new Decimal("1.5").plus("2").toString()).toBe("3.5");
    expect(() => new Decimal("1.5").plus(2 as never)).toThrow(
      DECIMAL_CONSTRUCTOR_REFUSAL
    );
    expect(new Decimal("1.5").minus("0.5").toString()).toBe("1");
    expect(new Decimal("1.5").times(new Decimal("2")).toString()).toBe("3");
  });

  test("keeps every operand pair's answer, in both directions", () => {
    for (const left of OPERANDS) {
      for (const right of OPERANDS) {
        const a = new Decimal(left);
        const b = new Decimal(right);
        expect(a.plus(b).toString()).toBe(b.plus(a).toString());
        expect(a.times(b).toString()).toBe(b.times(a).toString());
        expect(a.minus(b).toString()).toBe(b.minus(a).neg().toString());
        expect(a.plus(b).minus(b).eq(a)).toBe(true);
      }
    }
  });

  test("divides to a requested number of places, rounding as asked", () => {
    expect(new Decimal("1").div("3").toString()).toBe("0.33333333333333333333");
    expect(new Decimal("1").div("3", 5).toString()).toBe("0.33333");
    expect(new Decimal("10").div("4").toString()).toBe("2.5");
    expect(new Decimal("-10").div("4").toString()).toBe("-2.5");
    expect(new Decimal("10").div("-4").toString()).toBe("-2.5");
    expect(new Decimal("-10").div("-4").toString()).toBe("2.5");
    expect(new Decimal("0").div("4").toString()).toBe("0");
    // A tie: half-up sends it away from zero, half-even to the even neighbour.
    expect(new Decimal("1").div("8", 2).toString()).toBe("0.13");
    expect(new Decimal("1").div("8", 2, "half-up").toString()).toBe("0.13");
    expect(new Decimal("1").div("8", 2, "half-even").toString()).toBe("0.12");
    expect(new Decimal("3").div("8", 2, "half-even").toString()).toBe("0.38");
    expect(new Decimal("-1").div("8", 2, "half-up").toString()).toBe("-0.13");
    expect(new Decimal("-1").div("8", 2, "half-even").toString()).toBe("-0.12");
    // Below and above the tie, both modes agree.
    expect(new Decimal("1").div("16", 2, "half-up").toString()).toBe("0.06");
    expect(new Decimal("1").div("16", 2, "half-even").toString()).toBe("0.06");
    expect(new Decimal("7").div("8", 2, "half-up").toString()).toBe("0.88");
    expect(new Decimal("7").div("8", 2, "half-even").toString()).toBe("0.88");
  });

  test("refuses to divide by zero, however it was spelled", () => {
    for (const zero of ["0", "-0", "0.000", 0n, new Decimal("0")]) {
      expect(() => new Decimal("1").div(zero)).toThrow(RangeError);
    }
    expect(() => new Decimal("1").div("0")).toThrow("Division by zero");
  });

  test("refuses a place count that is not one", () => {
    // No guard of its own: `BigInt` refuses a fractional count and the
    // exponent operator refuses a negative one, each with its own sentence.
    expect(() => new Decimal("1").div("3", 1.5)).toThrow(RangeError);
    expect(() => new Decimal("1").div("3", -1)).toThrow(RangeError);
  });

  test("answers abs and neg, and zero has no sign to flip", () => {
    expect(new Decimal("-2.5").abs().toString()).toBe("2.5");
    expect(new Decimal("2.5").abs().toString()).toBe("2.5");
    expect(new Decimal("2.5").neg().toString()).toBe("-2.5");
    expect(new Decimal("-2.5").neg().toString()).toBe("2.5");
    expect(new Decimal("0").neg().toString()).toBe("0");
    expect(new Decimal("0").abs().toString()).toBe("0");
  });
});

describe("decimal value: comparison", () => {
  test("compares across scales, in all three directions", () => {
    expect(new Decimal("1.10").cmp("1.1")).toBe(0);
    expect(new Decimal("1").cmp("2")).toBe(-1);
    expect(new Decimal("2").cmp("1")).toBe(1);
    expect(new Decimal("-1").cmp("-2")).toBe(1);
    expect(new Decimal("0.0001").cmp("1000000")).toBe(-1);
  });

  test("answers each predicate at, below and above the operand", () => {
    const value = new Decimal("2");
    expect([value.eq("2"), value.eq("1"), value.eq("3")]).toEqual([
      true,
      false,
      false,
    ]);
    expect([value.lt("3"), value.lt("2"), value.lt("1")]).toEqual([
      true,
      false,
      false,
    ]);
    expect([value.lte("3"), value.lte("2"), value.lte("1")]).toEqual([
      true,
      true,
      false,
    ]);
    expect([value.gt("1"), value.gt("2"), value.gt("3")]).toEqual([
      true,
      false,
      false,
    ]);
    expect([value.gte("1"), value.gte("2"), value.gte("3")]).toEqual([
      true,
      true,
      false,
    ]);
  });
});

describe("decimal value: rendering", () => {
  test("renders every point position, with and without a sign", () => {
    for (const [input, canonical] of [
      ["0", "0"],
      ["123", "123"],
      ["-123", "-123"],
      ["0.5", "0.5"],
      ["-0.5", "-0.5"],
      ["0.0000001", "0.0000001"],
      ["-0.0000001", "-0.0000001"],
      ["123.456", "123.456"],
      ["-123.456", "-123.456"],
    ] as const) {
      expect(new Decimal(input).toString()).toBe(canonical);
    }
  });

  test("toFixed pads, rounds half away from zero, and keeps the sign", () => {
    expect(new Decimal("1.5").toFixed()).toBe("1.5");
    expect(new Decimal("1.5").toFixed(3)).toBe("1.500");
    expect(new Decimal("1.5").toFixed(0)).toBe("2");
    expect(new Decimal("-1.5").toFixed(0)).toBe("-2");
    expect(new Decimal("2.5").toFixed(0)).toBe("3");
    expect(new Decimal("-2.5").toFixed(0)).toBe("-3");
    expect(new Decimal("0.005").toFixed(2)).toBe("0.01");
    expect(new Decimal("-0.005").toFixed(2)).toBe("-0.01");
    // A value too small to show keeps the sign it had: `-0.00` says the value
    // was below zero, where `0.00` would say it was not.
    expect(new Decimal("-0.004").toFixed(2)).toBe("-0.00");
    expect(new Decimal("0.004").toFixed(2)).toBe("0.00");
    expect(new Decimal("0").toFixed(2)).toBe("0.00");
    expect(new Decimal("0").toFixed(0)).toBe("0");
    expect(new Decimal("1000000").toFixed(2)).toBe("1000000.00");
  });

  test("converts to a number, to JSON, and to a primitive", () => {
    expect(new Decimal("1.5").toNumber()).toBe(1.5);
    expect(new Decimal("-0.25").toNumber()).toBe(-0.25);
    expect(new Decimal("0").toNumber()).toBe(0);
    expect(new Decimal("1.5").valueOf()).toBe("1.5");
    expect(new Decimal("1.5").toJSON()).toBe("1.5");
    expect(JSON.stringify({ total: new Decimal("1.50") })).toBe(
      '{"total":"1.5"}'
    );
    expect(`${new Decimal("-2.5")}`).toBe("-2.5");
  });
});

describe("decimal value: the properties the ORM rests on", () => {
  test("two spellings of one number are one value and one key", () => {
    expect(new Decimal("1.10").toString()).toBe(new Decimal("1.1").toString());
    expect(new Decimal("-0").toString()).toBe("0");
    expect(new Decimal("0.000").toString()).toBe("0");
    expect(new Decimal("1.10").eq(new Decimal("1.1000"))).toBe(true);
  });

  test("an instance carries no own property and no static to configure", () => {
    const value: Decimal = new Decimal("1.5");
    expect(Object.keys(value)).toEqual([]);
    expect(Object.getOwnPropertyNames(value)).toEqual([]);
    expect(Object.getOwnPropertyNames(Decimal).sort()).toEqual([
      "length",
      "name",
      "prototype",
    ]);
    // A caller writing the internals another decimal library exposed writes
    // ordinary own properties that nothing here reads.
    Object.assign(value, { s: -1, e: 9, c: [9] });
    expect(value.toString()).toBe("1.5");
    expect(canonicalDecimalText(value)).toBe("1.5");
  });

  test("every operation answers a new instance and leaves its receiver alone", () => {
    const value = new Decimal("1.5");
    for (const answer of [
      value.plus("1"),
      value.minus("1"),
      value.times("2"),
      value.div("2"),
      value.abs(),
      value.neg(),
    ]) {
      expect(answer).not.toBe(value);
      expect(answer).toBeInstanceOf(Decimal);
    }
    expect(value.toString()).toBe("1.5");
  });

  test("construction is the only way into the family", () => {
    // `canonicalDecimalText` answering at all IS the family witness: it reads a
    // private field the constructor alone installs.
    expect(canonicalDecimalText(new Decimal("1"))).toBe("1");
    expect(canonicalDecimalText(fromCanonical("1.5"))).toBe("1.5");
    class Money extends Decimal {}
    expect(canonicalDecimalText(new Money("1.50"))).toBe("1.5");
    for (const impostor of [
      Object.create(Decimal.prototype),
      { s: 1, e: 0, c: [1] },
      "1.5",
      1.5,
      null,
      undefined,
      new Proxy(new Decimal("1.5"), {}),
    ]) {
      expect(canonicalDecimalText(impostor)).toBeUndefined();
    }
  });

  test("the canonical seam reads the value, not its prototype", () => {
    const value = fromCanonical("-12.34");
    const descriptor = Object.getOwnPropertyDescriptor(
      Decimal.prototype,
      "toString"
    );
    try {
      Object.defineProperty(Decimal.prototype, "toString", {
        configurable: true,
        writable: true,
        value: () => "999",
      });
      expect(value.toString()).toBe("999");
      expect(canonicalDecimalText(value)).toBe("-12.34");
    } finally {
      if (descriptor) {
        Object.defineProperty(Decimal.prototype, "toString", descriptor);
      }
    }
  });

  test("fromCanonical reads a validated spelling without re-testing it", () => {
    for (const canonical of ["0", "1", "-1", "12.34", "-0.0005"]) {
      expect(fromCanonical(canonical).toString()).toBe(canonical);
    }
  });

  test("structuredClone empties the value rather than refusing it", () => {
    // Worth pinning because it is quiet: the state is private, so a value
    // posted across a worker or a structuredClone-based cache arrives as an
    // empty object instead of throwing. Applications send `toString()`.
    expect(Object.keys(structuredClone(new Decimal("1.5")))).toEqual([]);
  });
});
