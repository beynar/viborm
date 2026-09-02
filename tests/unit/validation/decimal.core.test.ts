import { decimal } from "@schema/scalars";
import { parse as parseSchema } from "@validation";
import {
  canonicalizeDecimal,
  canonicalizeDecimalValue,
  canonicalizeMaterializedDecimal,
  coefficientToLogical,
  decimalColumnType,
  decimalDefaultText,
  decimalListDefaultText,
  decodeDecimalListContainer,
  decodeFieldScalar,
  decodePhysicalDecimal,
  decodePhysicalDecimalList,
  decodePhysicalWidenedSum,
  decodeWidenedSum,
  describeDescriptorRefusal,
  describeProviderLimitRefusal,
  encodeDecimalListContainer,
  encodePhysicalDecimal,
  encodePhysicalDecimalListMembers,
  logicalToCoefficient,
  materializePhysicalDecimal,
  materializePhysicalWidenedSum,
  sameDecimalDescriptor,
  toDecimal,
} from "@validation/primitives/decimal-codec";
import v from "@validation/primitives/v";
import { getScalarSchemas } from "@validation/scalars";
import Decimal from "decimal.js";
import { afterEach, describe, expect, test } from "vitest";

/** A Decimal CANDIDATE: `isDecimal` is duck-typed on this tag alone. */
const forge = (internals: Record<string, unknown>): unknown => ({
  toStringTag: "[object Decimal]",
  ...internals,
});

/** A genuinely constructed Decimal whose public internals were corrupted. */
const tamper = (internals: Record<string, unknown>): Decimal =>
  Object.assign(new Decimal(1), internals);

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

const inDomain = (
  precision: number,
  scale: number,
  value: unknown
): { value: string } | { issues: unknown[] } =>
  v.decimal({ decimal: { precision, scale } })["~standard"].validate(value) as
    | { value: string }
    | { issues: unknown[] };

afterEach(() => {
  // Every configuration test below mutates the constructor an application owns.
  Decimal.set({ defaults: true });
});

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
    // Zero has no sign — otherwise text equality would split -0 from 0
    expect(accepted("-0")).toBe("0");
    expect(accepted("-0.00")).toBe("0");
    expect(accepted("-01.2300")).toBe("-1.23");
  });

  test("equal numbers canonicalize to equal strings", () => {
    // This is the property every identity owner rests on
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

  test("refuses a bigint: the accepted input family is Decimal | string | number", () => {
    // It used to be canonicalized silently, which made `bigint` a fourth input
    // form no public type ever mentioned.
    expect(refused(9007199254740993n)).toBe(true);
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

describe("decimal value boundary", () => {
  test("accepts a Decimal and renders it exactly", () => {
    expect(accepted(new Decimal("1.2300"))).toBe("1.23");
    expect(accepted(new Decimal("-0"))).toBe("0");
    // A Decimal built from exponent notation is valid when its expanded value
    // fits; the raw exponent STRING stays outside the grammar.
    expect(accepted(new Decimal("1e21"))).toBe("1000000000000000000000");
    expect(refused("1e21")).toBe(true);
    expect(accepted(new Decimal("9007199254740993"))).toBe("9007199254740993");
  });

  test("accepts a Decimal from a clone of the constructor", () => {
    const Foreign = Decimal.clone({ precision: 3, rounding: Decimal.ROUND_UP });
    expect(accepted(new Foreign("123456789012345678901234567890.5"))).toBe(
      "123456789012345678901234567890.5"
    );
  });

  test("refuses a non-finite Decimal", () => {
    expect(refused(new Decimal(Number.NaN))).toBe(true);
    expect(refused(new Decimal(Number.POSITIVE_INFINITY))).toBe(true);
    expect(refused(new Decimal(Number.NEGATIVE_INFINITY))).toBe(true);
  });

  test("admits a complete representation and refuses incomplete forgeries", () => {
    // Decimal.js exposes no unforgeable construction witness, and accepting
    // arbitrary Decimal.clone() constructors rules out constructor identity as
    // one. The boundary therefore validates the complete observable numerical
    // representation. Empty, tag-only, incomplete, and invalid candidates are
    // still refused; a complete valid representation is accepted.
    const empty = Object.create(Decimal.prototype);
    expect(Decimal.isDecimal(empty)).toBe(true);
    expect(refused(empty)).toBe(true);

    const represented = Object.assign(Object.create(Decimal.prototype), {
      s: 1,
      e: 3,
      d: [1234],
    });
    expect(Decimal.isDecimal(represented)).toBe(true);
    expect(accepted(represented)).toBe("1234");

    const tagOnly = forge({});
    expect(Decimal.isDecimal(tagOnly)).toBe(true);
    expect(refused(tagOnly)).toBe(true);

    const incomplete = forge({ s: 1, e: 0 });
    expect(Decimal.isDecimal(incomplete)).toBe(true);
    expect(refused(incomplete)).toBe(true);

    const completeTaggedPlainObject = forge({ s: 1, e: 0, d: [1] });
    expect(Decimal.isDecimal(completeTaggedPlainObject)).toBe(true);
    expect(refused(completeTaggedPlainObject)).toBe(true);
    expect(canonicalizeDecimalValue(completeTaggedPlainObject)).toBeUndefined();

    // An ordinary object carrying the same field names is not even a candidate.
    const ordinary = { s: 1, e: 0, d: [1] };
    expect(refused(ordinary)).toBe(true);
  });

  test("refuses a copy whose internals are not the ones decimal.js builds", () => {
    // The copy is NOT a re-derivation: `new Decimal(candidate)` assigns `s` and
    // `e` verbatim and installs `candidate.d.slice()`, so a forged internal
    // reaches the renderer and comes back as NON-NUMERIC text that the
    // canonical reducer then passes straight through.
    expect(canonicalizeDecimal(tamper({ s: 1, e: 0, d: [Number.NaN] }))).toBe(
      undefined // was "N.aN"
    );
    expect(canonicalizeDecimal(tamper({ s: 1, e: 0, d: [] }))).toBe(
      undefined // was "u.ndefined"
    );
    expect(
      canonicalizeDecimal(
        tamper({
          s: 1,
          e: 0,
          d: [1, -1],
        })
      )
    ).toBe(undefined); // was "1.00000-1"
    // A word at or above the base is not a digit word: decimal.js divides the
    // last word's trailing zeros away, so `1e7` renders as the digit `1`.
    expect(
      canonicalizeDecimal(tamper({ s: 1, e: 0, d: [1e7] }))
    ).toBeUndefined();
    // A sign that is neither 1 nor -1 names no direction, and decimal.js writes
    // the value as positive — a number the candidate never carried.
    expect(canonicalizeDecimal(tamper({ s: 0, e: 0, d: [1] }))).toBeUndefined();
    // The copy's coefficient is whatever `candidate.d.slice()` returned, which
    // is not necessarily an array at all.
    expect(
      canonicalizeDecimal(tamper({ s: 1, e: 0, d: { slice: () => "1" } }))
    ).toBeUndefined();
  });

  test("refuses a forged internal WITHOUT rendering it", () => {
    // Every case here was measured at the render site against the pinned
    // decimal.js: the guard has to run BEFORE `toFixed()`, because none of
    // these ever comes back to be judged afterwards.
    //
    //   d: [null]  — `for (; w % 10 === 0;) w /= 10` with w = null, forever
    //   d: [1, 0]  — the same loop on a trailing zero WORD decimal.js never writes
    //   e: 1.5     — the zero-padding loop's `k--` never reaches zero
    //   1e9000000000 — a LEGITIMATE Decimal from the exported constructor,
    //                  finite and `isDecimal`, whose rendering is a
    //                  nine-gigabyte string: an out-of-memory crash, not an answer
    expect(
      canonicalizeDecimal(tamper({ s: 1, e: 0, d: [null] }))
    ).toBeUndefined();
    expect(
      canonicalizeDecimal(tamper({ s: 1, e: 0, d: [1, 0] }))
    ).toBeUndefined();
    expect(
      canonicalizeDecimal(tamper({ s: 1, e: 1.5, d: [1] }))
    ).toBeUndefined();
    const huge = new Decimal("1e9000000000");
    expect(Decimal.isDecimal(huge)).toBe(true);
    expect(huge.isFinite()).toBe(true);
    expect(canonicalizeDecimal(huge)).toBeUndefined();
    // The control: a thousand-digit value — the widest column PostgreSQL
    // stores — still renders every digit.
    expect(canonicalizeDecimal(new Decimal("1e999"))).toHaveLength(1000);

    const tooManyWords = new Array<number>(142_860);
    expect(
      canonicalizeDecimal(tamper({ s: 1, e: 0, d: tooManyWords }))
    ).toBeUndefined();

    const hostileLength = new Proxy([1], {
      get(target, property, receiver) {
        if (property === "length") return "1";
        return Reflect.get(target, property, receiver);
      },
    });
    expect(
      canonicalizeDecimal(tamper({ s: 1, e: 0, d: hostileLength }))
    ).toBeUndefined();

    const sparseWords = new Array<number>(1);
    expect(
      canonicalizeDecimal(tamper({ s: 1, e: 0, d: sparseWords }))
    ).toBeUndefined();
  });

  test("snapshots coefficient words before rendering trusted data", () => {
    // No caller method participates in the snapshot. In particular, the
    // decimal.js copy constructor would call this hostile `slice`; the codec
    // must instead read each dense coefficient word once into trusted storage,
    // then render only that plain snapshot.
    let reads = 0;
    let sliceCalls = 0;
    const shifting: unknown[] = [1];
    Object.defineProperty(shifting, "0", {
      get() {
        reads += 1;
        return reads === 1 ? 1 : Number.NaN;
      },
      enumerable: true,
      configurable: true,
    });
    Object.defineProperty(shifting, "slice", {
      value: () => {
        sliceCalls += 1;
        throw new Error("caller slice ran");
      },
      configurable: true,
    });
    const shifty = tamper({ s: 1, e: 0, d: shifting });
    expect(canonicalizeDecimal(shifty)).toBe("1");
    expect(reads).toBe(1);
    expect(sliceCalls).toBe(0);
  });

  test("does not invoke a hostile coefficient iterator", () => {
    let iteratorReads = 0;
    const words = new Proxy([1], {
      get(target, property, receiver) {
        if (property === Symbol.iterator) {
          iteratorReads += 1;
          throw new Error("iterator trap");
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const hostile = tamper({ d: words });
    expect(canonicalizeDecimal(hostile)).toBe("1");
    expect(iteratorReads).toBe(0);
  });

  test("reads each hostile Decimal datum once", () => {
    const reads = new Map<PropertyKey, number>();
    const candidate = new Proxy(new Decimal("1"), {
      get(target, property, receiver) {
        if (property === "s" || property === "e" || property === "d") {
          reads.set(property, (reads.get(property) ?? 0) + 1);
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(canonicalizeDecimal(candidate)).toBe("1");
    expect(reads).toEqual(
      new Map<PropertyKey, number>([
        ["s", 1],
        ["e", 1],
        ["d", 1],
      ])
    );
  });

  test("an invalid Decimal representation is refused at every boundary", () => {
    // `"N.aN"` would otherwise become the ONE private representation cursors,
    // row keys, cache keys, SQL literals and DDL defaults are all keyed on.
    const forged = forge({ s: 1, e: 0, d: [Number.NaN] });
    const schemas = getScalarSchemas(
      decimal({ precision: 10, scale: 2 })["~"].state
    );
    expect(schemas.create["~standard"].validate(forged)).toHaveProperty(
      "issues"
    );
    expect(
      schemas.update["~standard"].validate({ set: forged })
    ).toHaveProperty("issues");
    expect(
      schemas.filter["~standard"].validate({ equals: forged })
    ).toHaveProperty("issues");
    expect(canonicalizeDecimalValue(forged)).toBeUndefined();
    expect(decodeWidenedSum(forged, 2)).toBeUndefined();
    // The descriptor cannot be the net: it reads "N.aN" as five coefficient
    // digits and no fractional digit, so it finds nothing to refuse.
    expect(
      describeDescriptorRefusal("N.aN", { precision: 10, scale: 2 })
    ).toBeUndefined();
  });

  test("turns hostile Decimal identification, copy, and check phases into refusals", () => {
    const revocable = Proxy.revocable(new Decimal("1"), {});
    revocable.revoke();
    expect(refused(revocable.proxy)).toBe(true);
    expect(canonicalizeDecimalValue(revocable.proxy)).toBeUndefined();

    let constructionReads = 0;
    const hostileConstruction = new Proxy(new Decimal("1"), {
      get(target, property, receiver) {
        if (property === "s") {
          constructionReads += 1;
          throw new Error("construction trap");
        }
        return Reflect.get(target, property, receiver);
      },
    });
    expect(refused(hostileConstruction)).toBe(true);
    expect(constructionReads).toBe(1);

    const hostileCheck = tamper({
      s: 1,
      e: 0,
      d: {
        slice: () =>
          new Proxy([1], {
            get() {
              throw new Error("check trap");
            },
          }),
      },
    });
    expect(refused(hostileCheck)).toBe(true);
  });

  test("public parse contains external decimal-schema failures", () => {
    const custom = (validate: (value: Decimal) => unknown) =>
      v.decimal({
        schema: {
          "~standard": {
            version: 1,
            vendor: "decimal-core-test",
            validate,
          },
        } as never,
      });

    for (const schema of [
      custom(() => {
        throw new Error("custom exploded");
      }),
      custom(() => null),
      custom(() => Promise.resolve({ value: new Decimal("1") })),
    ]) {
      expect(() => parseSchema(schema, "1")).not.toThrow();
      expect(parseSchema(schema, "1")).toHaveProperty("issues");
    }

    const malformed = {
      "~standard": {
        version: 1,
        vendor: "decimal-core-test",
        validate: () => null,
      },
    } as never;
    expect(parseSchema(malformed, "1")).toEqual({
      issues: [{ message: "Schema returned a malformed validation result" }],
    });
  });

  test("materializes a fresh Decimal that compares by value, not identity", () => {
    const a = toDecimal("1.5");
    const b = toDecimal("1.50");
    expect(a).not.toBe(b);
    expect(a.eq(b)).toBe(true);
    expect(a).toBeInstanceOf(Decimal);
    expect(a.constructor).toBe(Decimal);
  });

  test("renders every exponent and base-1e7 word position from trusted data", () => {
    for (const { input, canonical } of [
      { input: "0", canonical: "0" },
      { input: "-0", canonical: "0" },
      { input: "0.0000001", canonical: "0.0000001" },
      { input: "10000000", canonical: "10000000" },
      { input: "10000001", canonical: "10000001" },
      { input: "1.0000001", canonical: "1.0000001" },
      { input: "100000000000001", canonical: "100000000000001" },
      {
        input: "-123456789012345.0000001",
        canonical: "-123456789012345.0000001",
      },
    ]) {
      expect(canonicalizeDecimal(new Decimal(input))).toBe(canonical);
      expect(canonicalizeMaterializedDecimal(toDecimal(canonical))).toBe(
        canonical
      );
    }
  });

  test("uses the captured Decimal family when the public identification helper is replaced", () => {
    const Foreign = Decimal.clone();
    const isDecimalDescriptor = Object.getOwnPropertyDescriptor(
      Decimal,
      "isDecimal"
    );
    try {
      Object.defineProperty(Decimal, "isDecimal", {
        configurable: true,
        value: () => false,
      });
      expect(canonicalizeDecimal(new Foreign("1.25"))).toBe("1.25");
      expect(canonicalizeMaterializedDecimal(toDecimal("1.25"))).toBe("1.25");
    } finally {
      if (isDecimalDescriptor) {
        Object.defineProperty(Decimal, "isDecimal", isDecimalDescriptor);
      }
    }
  });

  test("returns the exported constructor's configured arithmetic", () => {
    Decimal.set({ precision: 3, rounding: Decimal.ROUND_DOWN });
    const value = toDecimal("1.234");
    // biome-ignore lint/suspicious/useNumberToFixedDigitsArgument: this is decimal.js; the omitted digit count exposes its configured arithmetic precision.
    expect(value.plus("0.001").toFixed()).toBe("1.23");
    // biome-ignore lint/suspicious/useNumberToFixedDigitsArgument: this is decimal.js; the omitted digit count exposes its configured arithmetic precision.
    expect(value.times("2").toFixed()).toBe("2.46");
    value.sqrt();
    expect(Decimal.precision).toBe(3);
    expect(Decimal.rounding).toBe(Decimal.ROUND_DOWN);
  });

  test("keeps Decimal.js's ordinary enumerable value shape", () => {
    const value = toDecimal("1.234");
    const control = new Decimal("1.234");
    expect(Object.keys(value)).toEqual(Object.keys(control));
    expect(value).toEqual(control);
    expect(value.eq(control)).toBe(true);
  });

  test("canonicalizeDecimalValue admits only the Decimal family", () => {
    // The custom-schema RETURN position: a string or a number there is a
    // different value family, not a spelling of the same one.
    expect(canonicalizeDecimalValue(new Decimal("1.20"))).toBe("1.2");
    expect(canonicalizeDecimalValue("1.2")).toBeUndefined();
    expect(canonicalizeDecimalValue(1.2)).toBeUndefined();
    expect(canonicalizeDecimalValue(new Decimal(Number.NaN))).toBeUndefined();
  });
});

describe("decimal.js configuration cannot move a VibORM answer", () => {
  // The public constructor is the application's to configure (plan 2.4), so
  // every knob that could move a value is set hostile here and the same
  // answers are demanded. Both halves matter and they fail differently:
  // rendering through `toString` follows `toExpNeg`/`toExpPos`, and
  // CONSTRUCTION through the configured constructor follows `minE`/`maxE`.
  const SAMPLES = ["0.0000001", "1000000000000000000000", "9007199254740993"];
  const answers = () => [
    ...SAMPLES.map((text) => canonicalizeDecimal(text)),
    ...SAMPLES.map((text) => canonicalizeDecimal(toDecimal(text))),
    ...SAMPLES.map((text) => canonicalizeMaterializedDecimal(toDecimal(text))),
    // biome-ignore lint/suspicious/useNumberToFixedDigitsArgument: decimal.js, not Number — zero-argument `toFixed()` is the whole value in normal notation, and a digit count would round it away.
    ...SAMPLES.map((text) => toDecimal(text).toFixed()),
    accepted("0.0000001"),
    JSON.stringify(inDomain(30, 10, "0.0000001")),
  ];

  test("the application's rendering settings do not reach VibORM", () => {
    const before = answers();
    Decimal.set({
      precision: 5,
      rounding: Decimal.ROUND_UP,
      toExpNeg: -3,
      toExpPos: 3,
      modulo: Decimal.EUCLID,
    });
    // Control: these settings really do move the rendering VibORM refuses to
    // use, so the falsifier can fail.
    expect(new Decimal("9007199254740993").toString()).toBe(
      "9.007199254740993e+15"
    );
    expect(answers()).toEqual(before);
  });

  test("constructs exactly under a narrow exponent range and restores it", () => {
    const before = answers();
    Decimal.set({
      precision: 7,
      rounding: Decimal.ROUND_DOWN,
      toExpNeg: -3,
      toExpPos: 3,
      minE: -3,
      maxE: 5,
      modulo: Decimal.EUCLID,
    });
    // Control: on the configured constructor these values stop existing.
    expect(new Decimal("0.0000001").toFixed()).toBe("0");
    expect(new Decimal("1000000000000000000000").toFixed()).toBe("Infinity");
    expect(answers()).toEqual(before);

    const small = toDecimal("0.0000001");
    const large = toDecimal("1000000000000000000000");
    // biome-ignore lint/suspicious/useNumberToFixedDigitsArgument: this is decimal.js; zero arguments render the complete application arithmetic result.
    expect(small.toFixed()).toBe("0.0000001");
    // biome-ignore lint/suspicious/useNumberToFixedDigitsArgument: this is decimal.js; zero arguments render the complete application arithmetic result.
    expect(large.toFixed()).toBe("1000000000000000000000");
    expect(small.constructor).toBe(Decimal);
    expect(large.constructor).toBe(Decimal);
    expect(Decimal.precision).toBe(7);
    expect(Decimal.rounding).toBe(Decimal.ROUND_DOWN);
    expect(Decimal.toExpNeg).toBe(-3);
    expect(Decimal.toExpPos).toBe(3);
    expect(Decimal.minE).toBe(-3);
    expect(Decimal.maxE).toBe(5);
    expect(Decimal.modulo).toBe(Decimal.EUCLID);
  });

  test("restores the application's exponent range when construction fails", () => {
    Decimal.set({ minE: -3, maxE: 5 });
    expect(() => toDecimal("not a decimal")).toThrow();
    expect(Decimal.minE).toBe(-3);
    expect(Decimal.maxE).toBe(5);
  });

  test("uses the captured configuration function for exact construction", () => {
    Decimal.set({ minE: -3, maxE: 5 });
    const setDescriptor = Object.getOwnPropertyDescriptor(Decimal, "set");
    const configDescriptor = Object.getOwnPropertyDescriptor(Decimal, "config");
    try {
      Object.defineProperties(Decimal, {
        set: {
          configurable: true,
          value: () => {
            throw new Error("hostile Decimal.set ran");
          },
        },
        config: {
          configurable: true,
          value: () => {
            throw new Error("hostile Decimal.config ran");
          },
        },
      });
      const value = toDecimal("1000000000000000000000");
      // biome-ignore lint/suspicious/useNumberToFixedDigitsArgument: this is decimal.js; zero arguments render the complete application arithmetic result.
      expect(value.toFixed()).toBe("1000000000000000000000");
      expect(value.constructor).toBe(Decimal);
      expect(Decimal.minE).toBe(-3);
      expect(Decimal.maxE).toBe(5);
    } finally {
      if (setDescriptor) Object.defineProperty(Decimal, "set", setDescriptor);
      if (configDescriptor) {
        Object.defineProperty(Decimal, "config", configDescriptor);
      }
    }
  });

  test("later arithmetic follows the application's exponent range", () => {
    const small = toDecimal("0.0000001");
    const large = toDecimal("1000000000000000000000");
    Decimal.set({ minE: -3, maxE: 5 });

    expect(small.times(small).isZero()).toBe(true);
    expect(large.plus(large).isFinite()).toBe(false);
  });

  test("bounds the trusted cache renderer before it renders", () => {
    const outsideBound = toDecimal("1");
    Object.defineProperty(outsideBound, "e", { value: 1_000_001 });
    expect(canonicalizeMaterializedDecimal(outsideBound)).toBeUndefined();

    expect(canonicalizeMaterializedDecimal("1")).toBeUndefined();
    const malformedExponent = toDecimal("1");
    Object.defineProperty(malformedExponent, "e", { value: "0" });
    expect(canonicalizeMaterializedDecimal(malformedExponent)).toBeUndefined();
  });

  test("never consults mutable Decimal prototype renderers", () => {
    const toFixedDescriptor = Object.getOwnPropertyDescriptor(
      Decimal.prototype,
      "toFixed"
    );
    const isNegDescriptor = Object.getOwnPropertyDescriptor(
      Decimal.prototype,
      "isNeg"
    );
    const isZeroDescriptor = Object.getOwnPropertyDescriptor(
      Decimal.prototype,
      "isZero"
    );
    try {
      Decimal.prototype.toFixed = () => "2";
      Decimal.prototype.isNeg = () => true;
      Decimal.prototype.isZero = () => false;
      expect(canonicalizeDecimal(new Decimal("1"))).toBe("1");
      expect(canonicalizeDecimal(new Decimal("-1"))).toBe("-1");
      expect(canonicalizeMaterializedDecimal(toDecimal("1"))).toBe("1");
      expect(canonicalizeMaterializedDecimal(toDecimal("-1"))).toBe("-1");
    } finally {
      if (toFixedDescriptor) {
        Object.defineProperty(Decimal.prototype, "toFixed", toFixedDescriptor);
      }
      if (isNegDescriptor) {
        Object.defineProperty(Decimal.prototype, "isNeg", isNegDescriptor);
      }
      if (isZeroDescriptor) {
        Object.defineProperty(Decimal.prototype, "isZero", isZeroDescriptor);
      }
    }
  });
});

describe("declared domain", () => {
  test("compares the complete optional descriptor", () => {
    const money = { precision: 10, scale: 2 };
    expect(sameDecimalDescriptor(undefined, undefined)).toBe(true);
    expect(sameDecimalDescriptor(money, money)).toBe(true);
    expect(sameDecimalDescriptor(money, { precision: 10, scale: 2 })).toBe(
      true
    );
    expect(sameDecimalDescriptor(money, undefined)).toBe(false);
    expect(sameDecimalDescriptor(undefined, money)).toBe(false);
    expect(sameDecimalDescriptor(money, { precision: 11, scale: 2 })).toBe(
      false
    );
    expect(sameDecimalDescriptor(money, { precision: 10, scale: 3 })).toBe(
      false
    );
  });

  test("accepts values inside the domain without reformatting them", () => {
    // Scale is a domain limit, not display formatting: 1.2 stays 1.2.
    expect(inDomain(10, 5, "1.2")).toEqual({ value: "1.2" });
    expect(inDomain(10, 5, "1.20000")).toEqual({ value: "1.2" });
    expect(inDomain(10, 5, "-99999.99999")).toEqual({ value: "-99999.99999" });
    expect(inDomain(1, 0, "0")).toEqual({ value: "0" });
    expect(inDomain(5, 5, "0.12345")).toEqual({ value: "0.12345" });
  });

  test("refuses non-zero digits past the scale, rather than rounding them", () => {
    expect(inDomain(10, 2, "1.005")).toHaveProperty("issues");
    // The plan's own example: a double that already lost the value.
    expect(inDomain(10, 2, 0.1 + 0.2)).toHaveProperty("issues");
    // ...while the value the caller MEANT fits.
    expect(inDomain(10, 2, "0.3")).toEqual({ value: "0.3" });
  });

  test("refuses a coefficient wider than the precision", () => {
    expect(inDomain(10, 5, "99999.99999")).toEqual({ value: "99999.99999" });
    expect(inDomain(10, 5, "100000")).toHaveProperty("issues");
    expect(inDomain(18, 0, "9007199254740993")).toEqual({
      value: "9007199254740993",
    });
    expect(inDomain(15, 0, "9007199254740993")).toHaveProperty("issues");
  });

  test("names which bound was exceeded", () => {
    expect(
      describeDescriptorRefusal("1.005", { precision: 10, scale: 2 })
    ).toBe("Expected at most 2 fractional digits, but '1.005' has 3");
    expect(describeDescriptorRefusal("0.05", { precision: 10, scale: 1 })).toBe(
      "Expected at most 1 fractional digit, but '0.05' has 2"
    );
    expect(
      describeDescriptorRefusal("100000", { precision: 10, scale: 5 })
    ).toBe(
      "Expected an unscaled coefficient of at most 10 digits, but '100000' needs 11"
    );
    expect(
      describeDescriptorRefusal("1.2", { precision: 10, scale: 5 })
    ).toBeUndefined();
  });
});

describe("custom schema over the decimal value", () => {
  const observe = (
    validate: (
      value: Decimal
    ) => { value: unknown } | { issues: [{ message: string }] }
  ) => ({
    "~standard": {
      version: 1 as const,
      vendor: "decimal-core-test",
      validate: (value: unknown) => validate(value as Decimal),
    },
  });

  test("observes a Decimal, not the canonical text", () => {
    const seen: unknown[] = [];
    const schema = v.decimal({
      decimal: { precision: 10, scale: 2 },
      schema: observe((value) => {
        seen.push(value);
        return { value };
      }),
    });
    expect(schema["~standard"].validate("1.50")).toEqual({ value: "1.5" });
    expect(seen[0]).toBeInstanceOf(Decimal);
    // biome-ignore lint/suspicious/useNumberToFixedDigitsArgument: decimal.js, not Number — a digit count would round the value away.
    expect((seen[0] as Decimal).toFixed()).toBe("1.5");
  });

  test("the declared domain validates whatever the schema returned, LAST", () => {
    // A schema that widens the value cannot escape the field's domain.
    const schema = v.decimal({
      decimal: { precision: 10, scale: 2 },
      schema: observe(() => ({ value: new Decimal("1.005") })),
    });
    expect(schema["~standard"].validate("1.00")).toHaveProperty("issues");
  });

  test("refuses a return that is not a finite Decimal", () => {
    for (const returned of [
      "1.5",
      1.5,
      { s: 1, e: 0, d: [1] },
      forge({ s: 1, e: 0, d: [1] }),
      new Decimal(Number.NaN),
      new Decimal(Number.POSITIVE_INFINITY),
    ]) {
      const schema = v.decimal({
        decimal: { precision: 10, scale: 2 },
        schema: observe(() => ({ value: returned })),
      });
      expect(schema["~standard"].validate("1.00")).toHaveProperty("issues");
    }
  });

  test("keeps the schema's own refusal message", () => {
    const schema = v.decimal({
      schema: observe(() => ({ issues: [{ message: "not a price" }] })),
    });
    const result = schema["~standard"].validate("1.5") as {
      issues: [{ message: string }];
    };
    expect(result.issues[0].message).toBe("not a price");
  });

  test("refuses an async schema", () => {
    const schema = v.decimal({
      schema: {
        "~standard": {
          version: 1 as const,
          vendor: "decimal-core-test",
          validate: () => Promise.resolve({ value: new Decimal("1") }),
        },
      } as never,
    });
    expect(schema["~standard"].validate("1.5")).toHaveProperty("issues");
  });

  test("the custom schema does not change what the field accepts or emits", () => {
    // It refines the Decimal; the input family and the canonical output are the
    // field's, not the schema's.
    const schema = v.decimal({
      schema: observe((value) => ({ value })),
    });
    expect(schema["~standard"].validate(1.5)).toEqual({ value: "1.5" });
    expect(schema["~standard"].validate("1.50")).toEqual({ value: "1.5" });
    expect(schema["~standard"].validate(new Decimal("1.5"))).toEqual({
      value: "1.5",
    });
  });
});

describe("logical and coefficient conversion", () => {
  test("moves the point with digits, never with arithmetic", () => {
    expect(logicalToCoefficient("1.2", 2)).toBe("120");
    expect(logicalToCoefficient("-0.03", 2)).toBe("-3");
    expect(logicalToCoefficient("0", 2)).toBe("0");
    expect(logicalToCoefficient("0", 0)).toBe("0");
    expect(logicalToCoefficient("-12345", 0)).toBe("-12345");
    // Past 2^53, where a JS multiply would already be wrong.
    expect(logicalToCoefficient("90071992547409.93", 2)).toBe(
      "9007199254740993"
    );
  });

  test("round-trips every logical value at its scale", () => {
    for (const [canonical, scale] of [
      ["1.2", 2],
      ["-0.03", 2],
      ["0", 5],
      ["-12345", 0],
      ["90071992547409.93", 2],
      ["0.00001", 5],
    ] as const) {
      expect(
        coefficientToLogical(logicalToCoefficient(canonical, scale), scale)
      ).toBe(canonical);
    }
  });

  test("refuses any coefficient spelling this codec never wrote", () => {
    expect(coefficientToLogical("120", 2)).toBe("1.2");
    expect(coefficientToLogical("0", 2)).toBe("0");
    for (const bad of [
      "+1",
      "-",
      "-0",
      "01",
      "1.0",
      "1e3",
      "",
      " 1",
      "abc",
      120,
    ]) {
      expect(coefficientToLogical(bad, 2)).toBeUndefined();
    }
  });

  test("canonicalizes a coefficient without dropping integer zeros", () => {
    expect(coefficientToLogical("12000", 2)).toBe("120");
    expect(coefficientToLogical("100", 2)).toBe("1");
    expect(coefficientToLogical("100", 5)).toBe("0.001");
    expect(coefficientToLogical("-100", 5)).toBe("-0.001");
  });

  test("decodes a widened sum: the field's scale, not the field's precision", () => {
    // A million precision-10 rows sum to an answer no single column could hold.
    expect(decodeWidenedSum("123456789012345.67", 2)).toBe(
      "123456789012345.67"
    );
    expect(decodeWidenedSum("1.20", 2)).toBe("1.2");
    expect(decodeWidenedSum("-0.00", 2)).toBe("0");
    expect(decodeWidenedSum("1.005", 2)).toBeUndefined();
    expect(decodeWidenedSum("nonsense", 2)).toBeUndefined();
  });

  test("decodes one scalar field value from native decimal TEXT", () => {
    // The PostgreSQL/MySQL scalar-read half: the column the schema declared
    // cannot answer outside its own domain, so a wider value is a column that
    // no longer matches the model rather than a number to widen the field for.
    const money = { precision: 10, scale: 2 };
    expect(decodeFieldScalar("1.20", money)).toBe("1.2");
    expect(decodeFieldScalar("-1.20", money)).toBe("-1.2");
    expect(decodeFieldScalar("0.00", money)).toBe("0");
    expect(decodeFieldScalar("-0.00", money)).toBe("0");
    expect(decodeFieldScalar("1.005", money)).toBeUndefined();
    expect(decodeFieldScalar("123456789.00", money)).toBeUndefined();
    expect(decodeFieldScalar("10.00", { precision: 4, scale: 2 })).toBe("10");
    expect(
      decodeFieldScalar("10.00", { precision: 3, scale: 2 })
    ).toBeUndefined();
    expect(decodeFieldScalar("0.00001", { precision: 1, scale: 5 })).toBe(
      "0.00001"
    );
    expect(
      decodeFieldScalar("0.00100", { precision: 2, scale: 5 })
    ).toBeUndefined();
  });

  test("a scalar field value is TEXT, and only the spellings an adapter writes", () => {
    const money = { precision: 10, scale: 2 };
    for (const outside of [
      1.2,
      new Decimal("1.2"),
      120n,
      "+1.2",
      ".5",
      "1.",
      "01.2",
      "-",
      "1.x",
      "1e3",
      "",
      null,
      undefined,
    ]) {
      expect(decodeFieldScalar(outside, money)).toBeUndefined();
    }
  });

  test("a widened sum is provider TEXT, and only the spellings an adapter writes", () => {
    // It is a DECODE entry: it names the exact physical representation the
    // active adapter promised, so a `Number` fallback, a provider-owned
    // instance, or a spelling no adapter emits is a malformed row rather than a
    // value. A mysql2 configured with `decimalNumbers` would otherwise be
    // laundered into an "exact" sum here.
    expect(decodeWidenedSum(0.1 + 0.2, 20)).toBeUndefined();
    expect(decodeWidenedSum(new Decimal("1.20"), 2)).toBeUndefined();
    expect(decodeWidenedSum(120, 2)).toBeUndefined();
    expect(decodeWidenedSum("+1.2", 2)).toBeUndefined();
    expect(decodeWidenedSum(".5", 1)).toBeUndefined();
    expect(decodeWidenedSum("1.", 0)).toBeUndefined();
    expect(decodeWidenedSum("01.2", 1)).toBeUndefined();
    expect(decodeWidenedSum(null, 2)).toBeUndefined();
  });
});

describe("provider physical representation", () => {
  const money = { precision: 16, scale: 2 } as const;

  test("encodes and decodes scalar text and coefficient vocabularies", () => {
    expect(encodePhysicalDecimal("1.2", money, "text")).toBe("1.2");
    expect(encodePhysicalDecimal("1.2", money, "coefficient")).toBe("120");
    expect(decodePhysicalDecimal("1.20", money, "text")).toBe("1.2");
    expect(decodePhysicalDecimal("120", money, "coefficient")).toBe("1.2");

    expect(decodePhysicalDecimal(1.2, money, "text")).toBeUndefined();
    expect(decodePhysicalDecimal("1.2", money, "coefficient")).toBeUndefined();
    expect(
      decodePhysicalDecimal("99999999999999999", money, "coefficient")
    ).toBeUndefined();
  });

  test("materializes one exact public value directly from each vocabulary", () => {
    const text = materializePhysicalDecimal("1.20", money, "text");
    const coefficient = materializePhysicalDecimal("120", money, "coefficient");
    const coefficientZero = materializePhysicalDecimal(
      "0",
      money,
      "coefficient"
    );
    const zero = materializePhysicalDecimal("-0.00", money, "text");

    expect(text).toBeInstanceOf(Decimal);
    expect(text?.eq("1.2")).toBe(true);
    expect(coefficient).toBeInstanceOf(Decimal);
    expect(coefficient?.eq("1.2")).toBe(true);
    expect(coefficientZero?.isZero()).toBe(true);
    expect(coefficientZero?.isNegative()).toBe(false);
    expect(zero?.isNegative()).toBe(false);
    expect(materializePhysicalDecimal(1.2, money, "text")).toBeUndefined();
    expect(
      materializePhysicalDecimal("99999999999999999", money, "coefficient")
    ).toBeUndefined();

    const widened = materializePhysicalWidenedSum(
      "12345678901234567",
      money,
      "coefficient"
    );
    const widenedText = materializePhysicalWidenedSum(
      "123456789012345.67",
      money,
      "text"
    );
    const integerCoefficient = materializePhysicalDecimal(
      "-12",
      { precision: 2, scale: 0 },
      "coefficient"
    );
    expect(widened?.eq("123456789012345.67")).toBe(true);
    expect(widenedText?.eq("123456789012345.67")).toBe(true);
    expect(integerCoefficient?.eq("-12")).toBe(true);
    expect(
      materializePhysicalWidenedSum("1.005", money, "text")
    ).toBeUndefined();
  });

  test("encodes members and decodes the provider-specific list container", () => {
    expect(
      encodePhysicalDecimalListMembers(
        ["1.2", "-0.03", "90071992547409.93"],
        money,
        "text"
      )
    ).toEqual(["1.2", "-0.03", "90071992547409.93"]);
    expect(
      encodePhysicalDecimalListMembers(
        ["1.2", "-0.03", "90071992547409.93"],
        money,
        "coefficient"
      )
    ).toEqual(["120", "-3", "9007199254740993"]);
    expect(
      encodePhysicalDecimalListMembers(
        ["1.2", "not-a-decimal"],
        money,
        "coefficient"
      )
    ).toBeUndefined();

    expect(decodePhysicalDecimalList(["1.20", "-0.03"], money, "text")).toEqual(
      ["1.2", "-0.03"]
    );
    expect(
      decodePhysicalDecimalList('["120","-3"]', money, "coefficient")
    ).toEqual(["1.2", "-0.03"]);

    expect(
      decodePhysicalDecimalList('[120,"-3"]', money, "coefficient")
    ).toBeUndefined();
    expect(
      decodePhysicalDecimalList(["120", null], money, "text")
    ).toBeUndefined();
    expect(decodePhysicalDecimalList("[]", money, "text")).toBeUndefined();
    expect(
      decodePhysicalDecimalList(new Array<string>(1), money, "text")
    ).toBeUndefined();
    expect(
      decodePhysicalDecimalList('["99999999999999999"]', money, "coefficient")
    ).toBeUndefined();
  });

  test("contains hostile native decimal arrays as malformed provider data", () => {
    const revoked = Proxy.revocable(["1.20"], {});
    revoked.revoke();
    expect(
      decodePhysicalDecimalList(revoked.proxy, money, "text")
    ).toBeUndefined();

    const hostileLength = new Proxy(["1.20"], {
      get(target, property, receiver) {
        if (property === "length") throw new Error("private provider trap");
        return Reflect.get(target, property, receiver);
      },
    });
    expect(
      decodePhysicalDecimalList(hostileLength, money, "text")
    ).toBeUndefined();

    const invalidLength = new Proxy(["1.20"], {
      get(target, property, receiver) {
        if (property === "length") return -1;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(
      decodePhysicalDecimalList(invalidLength, money, "text")
    ).toBeUndefined();

    const hostileMember = new Proxy(["1.20"], {
      get(target, property, receiver) {
        if (property === "0") throw new Error("private provider member");
        return Reflect.get(target, property, receiver);
      },
    });
    expect(
      decodePhysicalDecimalList(hostileMember, money, "text")
    ).toBeUndefined();
  });

  test("decodes widened sums in both vocabularies without materializing Decimal", () => {
    const text = decodePhysicalWidenedSum("123456789012345.67", money, "text");
    const coefficient = decodePhysicalWidenedSum(
      "12345678901234567",
      money,
      "coefficient"
    );

    expect(text).toBe("123456789012345.67");
    expect(coefficient).toBe("123456789012345.67");
    expect(text).not.toBeInstanceOf(Decimal);
    expect(coefficient).not.toBeInstanceOf(Decimal);
    expect(decodePhysicalWidenedSum("1.005", money, "text")).toBeUndefined();
    expect(
      decodePhysicalWidenedSum("01", money, "coefficient")
    ).toBeUndefined();
  });
});

describe("the two DDL renderings", () => {
  test("emits the physical type with no space after the comma", () => {
    const domain = { precision: 10, scale: 5 };
    expect(decimalColumnType("pg", domain)).toBe("NUMERIC(10,5)");
    expect(decimalColumnType("mysql", domain)).toBe("DECIMAL(10,5)");
    // SQLite ignores the numbers in a declared decimal type, so it stores the
    // coefficient and the migration driver checks its range.
    expect(decimalColumnType("sqlite", domain)).toBe("INTEGER");
  });

  test("emits a default at exactly `scale` fractional digits, or the coefficient", () => {
    const domain = { precision: 10, scale: 5 };
    // Canonical text is "1.2"; MySQL reads a DECIMAL(10,5) default back as
    // "1.20000", so the differ must be handed the congruent spelling.
    expect(decimalDefaultText("pg", "1.2", domain)).toBe("1.20000");
    expect(decimalDefaultText("mysql", "-1.2", domain)).toBe("-1.20000");
    expect(decimalDefaultText("mysql", "0", domain)).toBe("0.00000");
    expect(decimalDefaultText("sqlite", "1.2", domain)).toBe("120000");
    expect(decimalDefaultText("pg", "12", { precision: 5, scale: 0 })).toBe(
      "12"
    );
    expect(
      decimalDefaultText("sqlite", "-12", { precision: 5, scale: 0 })
    ).toBe("-12");
  });

  test("renders list defaults in the provider's one physical vocabulary", () => {
    const domain = { precision: 10, scale: 2 };
    expect(decimalListDefaultText("pg", ["1.2", "-0.03"], domain)).toBe(
      "{1.20,-0.03}"
    );
    expect(decimalListDefaultText("mysql", ["1.2", "-0.03"], domain)).toBe(
      '["120","-3"]'
    );
    expect(decimalListDefaultText("sqlite", [], domain)).toBe("[]");
  });

  test("names each provider admission bound", () => {
    expect(
      describeProviderLimitRefusal("pg", { precision: 1001, scale: 0 })
    ).toContain("maximum precision of 1000");
    expect(
      describeProviderLimitRefusal("mysql", { precision: 30, scale: 31 })
    ).toContain("maximum scale of 30");
    expect(
      describeProviderLimitRefusal("mysql", { precision: 36, scale: 30 })
    ).toContain("precision + scale <= 65");
    expect(
      describeProviderLimitRefusal("sqlite", { precision: 9, scale: 9 })
    ).toBeUndefined();
  });
});

describe("the JSON list container", () => {
  test("carries members as coefficient strings, never as JSON numbers", () => {
    expect(encodeDecimalListContainer(["1.2", "-0.03"], 2)).toBe(
      '["120","-3"]'
    );
    expect(encodeDecimalListContainer([], 2)).toBe("[]");
    // Above 2^53, which a JSON numeric token would round.
    expect(encodeDecimalListContainer(["90071992547409.93"], 2)).toBe(
      '["9007199254740993"]'
    );
  });

  test("decodes back to logical members, preserving order and multiplicity", () => {
    expect(decodeDecimalListContainer('["120","-3","120"]', 2)).toEqual([
      "1.2",
      "-0.03",
      "1.2",
    ]);
    expect(decodeDecimalListContainer("[]", 2)).toEqual([]);
  });

  test("refuses every container this codec never wrote", () => {
    for (const bad of [
      "[120]", // a JSON numeric token
      '["+1"]',
      '["-0"]',
      '["01"]',
      '["1.0"]',
      "[null]",
      '["120"', // malformed JSON
      '{"0":"120"}', // wrong top level
      '"120"',
      120,
      null,
    ]) {
      expect(decodeDecimalListContainer(bad, 2)).toBeUndefined();
    }
  });
});
