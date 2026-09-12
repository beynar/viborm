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
import Decimal from "big.js";
import { afterEach, describe, expect, test } from "vitest";

/**
 * A Decimal CANDIDATE: big.js has no construction witness at all, so family
 * membership is the one prototype every one of its constructors shares.
 */
const forge = (internals: Record<string, unknown>): unknown =>
  Object.assign(Object.create(Decimal.prototype), internals);

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
  // big.js has no `set`, and no `defaults: true`: the five statics are restored
  // one by one to the values big.js ships.
  Decimal.DP = 20;
  Decimal.RM = 1;
  Decimal.NE = -7;
  Decimal.PE = 21;
  Decimal.strict = false;
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

  test("accepts a Decimal from a second constructor", () => {
    // big.js's clone is a ZERO-ARGUMENT call of the constructor itself. Its
    // instances share the one prototype object, so the captured family admits
    // them and a differently configured constructor is not a foreign value.
    const Foreign = Decimal();
    Foreign.DP = 3;
    Foreign.RM = 3;
    expect(accepted(new Foreign("123456789012345678901234567890.5"))).toBe(
      "123456789012345678901234567890.5"
    );
  });

  test("big.js constructs no non-finite value at all", () => {
    // The refusal moved into the library: there is no NaN Decimal and no
    // infinite Decimal to hand this codec, so `canonicalizeDecimal` never sees
    // one and the application learns about it at its own construction site.
    expect(() => new Decimal(Number.NaN)).toThrow();
    expect(() => new Decimal(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => new Decimal(Number.NEGATIVE_INFINITY)).toThrow();
    expect(() => new Decimal("abc")).toThrow();
  });

  test("admits a complete representation and refuses incomplete forgeries", () => {
    // big.js exposes no construction witness at all — no `isDecimal`, no tag —
    // and its second constructors are intentionally accepted, which rules out
    // constructor identity too. The boundary therefore validates the complete
    // observable numerical representation. Empty and incomplete candidates are
    // refused; a complete valid representation is accepted.
    const empty = Object.create(Decimal.prototype);
    expect(empty).toBeInstanceOf(Decimal);
    expect(refused(empty)).toBe(true);

    const represented = forge({ s: 1, e: 3, c: [1, 2, 3, 4] });
    expect(represented).toBeInstanceOf(Decimal);
    expect(accepted(represented)).toBe("1234");

    const incomplete = forge({ s: 1, e: 0 });
    expect(incomplete).toBeInstanceOf(Decimal);
    expect(refused(incomplete)).toBe(true);

    // An ordinary object carrying the same field names is not a candidate: it
    // is outside the one prototype family, which is the only witness there is.
    const ordinary = { s: 1, e: 0, c: [1] };
    expect(ordinary).not.toBeInstanceOf(Decimal);
    expect(refused(ordinary)).toBe(true);
    expect(canonicalizeDecimalValue(ordinary)).toBeUndefined();
  });

  test("refuses internals that are not the ones big.js builds", () => {
    // The render is a DIGIT CONCATENATION over the candidate's own coefficient,
    // so a forged member is written into the canonical text verbatim and the
    // canonical reducer then passes that non-numeric text straight through.
    expect(canonicalizeDecimal(tamper({ s: 1, e: 0, c: [Number.NaN] }))).toBe(
      undefined // would have been "NaN"
    );
    // An empty coefficient renders no digits: empty text names no number.
    expect(canonicalizeDecimal(tamper({ s: 1, e: 0, c: [] }))).toBe(undefined);
    expect(
      canonicalizeDecimal(tamper({ s: 1, e: 0, c: [1, -1] }))
    ).toBeUndefined(); // would have been "1.-1"
    // big.js packs ONE digit per member, so anything above nine is two
    // characters of text rather than a digit.
    expect(
      canonicalizeDecimal(tamper({ s: 1, e: 0, c: [10] }))
    ).toBeUndefined();
    // A sign that is neither 1 nor -1 names no direction, and the render writes
    // the value as positive — a number the candidate never carried.
    expect(canonicalizeDecimal(tamper({ s: 0, e: 0, c: [1] }))).toBeUndefined();
    // The coefficient is read as an array or not at all.
    expect(
      canonicalizeDecimal(tamper({ s: 1, e: 0, c: { slice: () => "1" } }))
    ).toBeUndefined();
  });

  test("a trailing zero digit is not refused: it names the same number", () => {
    // Under decimal.js a trailing zero WORD was a safety refusal — the loop
    // that stripped it divided by ten forever. big.js's render is total, and
    // a coefficient big.js would have written as [1] with e 1 renders from
    // [1, 0] to the very same canonical text, so there is no unique coverage
    // left to name and no guard here.
    expect(canonicalizeDecimal(tamper({ s: 1, e: 1, c: [1, 0] }))).toBe(
      canonicalizeDecimal(new Decimal("10"))
    );
    expect(canonicalizeDecimal(tamper({ s: 1, e: 0, c: [0, 0] }))).toBe("0");
  });

  test("refuses a forged internal WITHOUT rendering it", () => {
    // The snapshot has to complete BEFORE any text is built, because none of
    // these ever comes back to be judged afterwards.
    //
    //   c: [null]  — `null` is written into the digit text verbatim
    //   e: 1.5     — a fractional exponent never terminates the zero-run that
    //                the plain rendering repeats
    //   1e9000000000 — a LEGITIMATE Decimal from the exported constructor,
    //                  whose plain rendering is a nine-gigabyte string: an
    //                  out-of-memory crash, not an answer. big.js clamps no
    //                  exponent, so MAX_RENDER_EXPONENT is the only bound.
    expect(
      canonicalizeDecimal(tamper({ s: 1, e: 0, c: [null] }))
    ).toBeUndefined();
    expect(
      canonicalizeDecimal(tamper({ s: 1, e: 1.5, c: [1] }))
    ).toBeUndefined();
    const huge = new Decimal("1e9000000000");
    expect(huge).toBeInstanceOf(Decimal);
    expect(huge.e).toBe(9_000_000_000);
    expect(canonicalizeDecimal(huge)).toBeUndefined();
    // The control: a thousand-digit value — the widest column PostgreSQL
    // stores — still renders every digit.
    expect(canonicalizeDecimal(new Decimal("1e999"))).toHaveLength(1000);

    // One digit per coefficient member, so the bound is a DIGIT count:
    // MAX_RENDER_EXPONENT + 1 = 1_000_001 is the widest renderable integer.
    const tooManyDigits = new Array<number>(1_000_002);
    expect(
      canonicalizeDecimal(tamper({ s: 1, e: 0, c: tooManyDigits }))
    ).toBeUndefined();

    const hostileLength = new Proxy([1], {
      get(target, property, receiver) {
        if (property === "length") return "1";
        return Reflect.get(target, property, receiver);
      },
    });
    expect(
      canonicalizeDecimal(tamper({ s: 1, e: 0, c: hostileLength }))
    ).toBeUndefined();

    const sparseDigits = new Array<number>(1);
    expect(
      canonicalizeDecimal(tamper({ s: 1, e: 0, c: sparseDigits }))
    ).toBeUndefined();
  });

  test("snapshots coefficient digits before rendering trusted data", () => {
    // No caller method participates in the snapshot: the codec reads each dense
    // coefficient digit once into trusted storage and renders only that plain
    // snapshot, so a caller-owned `slice` never runs.
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
    const shifty = tamper({ s: 1, e: 0, c: shifting });
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
    const hostile = tamper({ c: words });
    expect(canonicalizeDecimal(hostile)).toBe("1");
    expect(iteratorReads).toBe(0);
  });

  test("reads each hostile Decimal datum once", () => {
    const reads = new Map<PropertyKey, number>();
    const candidate = new Proxy(new Decimal("1"), {
      get(target, property, receiver) {
        if (property === "s" || property === "e" || property === "c") {
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
        ["c", 1],
      ])
    );
  });

  test("an invalid Decimal representation is refused at every boundary", () => {
    // `"NaN"` would otherwise become the ONE private representation cursors,
    // row keys, cache keys, SQL literals and DDL defaults are all keyed on.
    const forged = forge({ s: 1, e: 0, c: [Number.NaN] });
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
    // The descriptor cannot be the net: it reads "NaN" as three coefficient
    // digits and no fractional digit, so it finds nothing to refuse.
    expect(
      describeDescriptorRefusal("NaN", { precision: 10, scale: 2 })
    ).toBeUndefined();
  });

  test("turns hostile Decimal identification and snapshot phases into refusals", () => {
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
      c: new Proxy([1], {
        get() {
          throw new Error("check trap");
        },
      }),
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

  test("renders every exponent and digit position from trusted data", () => {
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

  test("never consults the forgeable own `constructor` property", () => {
    // big.js writes `constructor` as an OWN property of every instance
    // (`x.constructor = Big`), so it is forgeable in both directions and says
    // nothing about the family. The captured prototype is the only witness.
    const lying = Object.assign(new Decimal("1.25"), { constructor: Object });
    expect(canonicalizeDecimal(lying)).toBe("1.25");
    expect(canonicalizeDecimalValue(lying)).toBe("1.25");

    const impostor = { s: 1, e: 0, c: [1], constructor: Decimal };
    expect(canonicalizeDecimal(impostor)).toBeUndefined();
    expect(canonicalizeDecimalValue(impostor)).toBeUndefined();
  });

  test("returns the exported constructor's configured arithmetic", () => {
    // `Big.DP` is DECIMAL PLACES, not significant digits, and it reaches only
    // division, sqrt and negative powers.
    Decimal.DP = 3;
    Decimal.RM = 0;
    const value = toDecimal("1");
    expect(value.div("3").toString()).toBe("0.333");
    expect(Decimal.DP).toBe(3);
    expect(Decimal.RM).toBe(0);
  });

  test("keeps big.js's ordinary enumerable value shape", () => {
    const value = toDecimal("1.234");
    const control = new Decimal("1.234");
    // big.js writes an own `constructor` beside the three numeric internals.
    expect(Object.keys(control)).toEqual(["s", "e", "c", "constructor"]);
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
    expect(
      canonicalizeDecimalValue(forge({ s: 1, e: 1_000_001, c: [1] }))
    ).toBeUndefined();
  });
});

describe("big.js configuration cannot move a VibORM answer", () => {
  // The public constructor is the application's to configure (plan 2.4), so
  // every knob that could move a value is set hostile here and the same answers
  // are demanded. big.js's five statics split cleanly: `NE`/`PE` move the
  // library's own RENDERING, `DP`/`RM` move its division and rounding, and
  // `strict` moves what its CONSTRUCTOR accepts. None of the three reaches a
  // VibORM answer, and each half fails differently.
  const SAMPLES = ["0.0000001", "1000000000000000000000", "9007199254740993"];
  const answers = () => [
    ...SAMPLES.map((text) => canonicalizeDecimal(text)),
    ...SAMPLES.map((text) => canonicalizeDecimal(toDecimal(text))),
    ...SAMPLES.map((text) => canonicalizeMaterializedDecimal(toDecimal(text))),
    // biome-ignore lint/suspicious/useNumberToFixedDigitsArgument: big.js, not Number — zero-argument `toFixed()` is the whole value in normal notation, ignores NE/PE, and rounds nothing; a digit count would round it away.
    ...SAMPLES.map((text) => toDecimal(text).toFixed()),
    accepted("0.0000001"),
    JSON.stringify(inDomain(30, 10, "0.0000001")),
  ];

  test("the application's rendering settings do not reach VibORM", () => {
    const before = answers();
    Decimal.NE = -3;
    Decimal.PE = 3;
    // Control: these settings really do move the rendering VibORM refuses to
    // use — `toString`/`toJSON` follow NE and PE and emit exponent notation.
    expect(new Decimal("9007199254740993").toString()).toBe(
      "9.007199254740993e+15"
    );
    expect(new Decimal("0.0000001").toString()).toBe("1e-7");
    expect(new Decimal("0.0000001").toJSON()).toBe("1e-7");
    expect(answers()).toEqual(before);
  });

  test("the application's division settings do not reach VibORM", () => {
    const before = answers();
    Decimal.DP = 0;
    Decimal.RM = 3;
    // Control: division and rounding really do move under DP and RM.
    expect(new Decimal("1").div("3").toString()).toBe("1");
    expect(new Decimal("1.4").round().toString()).toBe("2");
    expect(answers()).toEqual(before);
  });

  test("strict mode does not stop VibORM constructing or canonicalizing", () => {
    const before = answers();
    Decimal.strict = true;
    // Control: strict mode really does reject a primitive number and refuse
    // the implicit coercions an application might rely on.
    expect(() => new Decimal(1.5)).toThrow();
    expect(() => new Decimal("1.5").valueOf()).toThrow();
    // VibORM constructs from canonical STRINGS only, which strict mode admits.
    expect(answers()).toEqual(before);
    expect(toDecimal("1.5").eq(new Decimal("1.5"))).toBe(true);
    expect(accepted(new Decimal("1.50"))).toBe("1.5");
  });

  test("later arithmetic on a VibORM value follows the application's settings", () => {
    // The other direction of the same contract: VibORM hands back an instance
    // of the constructor the application owns, so the application's `DP`/`RM`
    // govern every operation it performs on that instance afterwards.
    const value = toDecimal("1");
    Decimal.RM = 0;
    Decimal.DP = 2;
    expect(value.div("3").toString()).toBe("0.33");
    Decimal.DP = 5;
    expect(value.div("3").toString()).toBe("0.33333");
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
    // ONE prototype object backs every big.js constructor, so replacing a
    // method here replaces it for the whole family at once.
    const RENDERERS = ["toFixed", "toString", "valueOf", "toJSON"] as const;
    const descriptors = RENDERERS.map(
      (name) =>
        [
          name,
          Object.getOwnPropertyDescriptor(Decimal.prototype, name),
        ] as const
    );
    try {
      for (const name of RENDERERS) {
        Object.defineProperty(Decimal.prototype, name, {
          configurable: true,
          writable: true,
          value: () => "2",
        });
      }
      // Control: the library's own rendering is now a lie.
      expect(new Decimal("1").toFixed()).toBe("2");
      expect(new Decimal("1").toString()).toBe("2");
      expect(canonicalizeDecimal(new Decimal("1"))).toBe("1");
      expect(canonicalizeDecimal(new Decimal("-1"))).toBe("-1");
      expect(canonicalizeMaterializedDecimal(toDecimal("1"))).toBe("1");
      expect(canonicalizeMaterializedDecimal(toDecimal("-1"))).toBe("-1");
    } finally {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) {
          Object.defineProperty(Decimal.prototype, name, descriptor);
        }
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
    // biome-ignore lint/suspicious/useNumberToFixedDigitsArgument: big.js, not Number — a digit count would round the value away.
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

  test("refuses a return that is not a complete Decimal representation", () => {
    for (const returned of [
      "1.5",
      1.5,
      { s: 1, e: 0, c: [1] },
      forge({}),
      forge({ s: 1, e: 0 }),
      forge({ s: 1, e: 0, c: [10] }),
      forge({ s: 1, e: 1_000_001, c: [1] }),
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
    expect(coefficientZero?.eq(0)).toBe(true);
    // big.js carries a minus on zero (`new Decimal("-0").s` is -1), so a
    // positive sign here says the codec spelled the canonical "0" it was given,
    // not that the library lost the sign.
    expect(coefficientZero?.s).toBe(1);
    expect(zero?.eq(0)).toBe(true);
    expect(zero?.s).toBe(1);
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
