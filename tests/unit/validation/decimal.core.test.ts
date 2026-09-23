import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decimal } from "@schema/scalars";
import { Decimal } from "@src/index";
import { REPOSITORY_ROOT } from "@tests/fixtures/repo-paths";
import { parse as parseSchema } from "@validation";
import {
  canonicalizeDecimal,
  canonicalizeMaterializedDecimal,
  decimalColumnType,
  decimalDefaultText,
  decimalListDefaultText,
  decodeDecimalListContainer,
  decodeFieldScalar,
  decodePhysicalDecimal,
  decodePhysicalDecimalList,
  decodePhysicalWidenedSum,
  decodeWidenedSum,
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
import {
  canonicalDecimalText,
  DECIMAL_CONSTRUCTOR_REFUSAL,
  DECIMAL_INPUT_REFUSAL,
  domainRefusal,
} from "@validation/primitives/decimal-value";
import v from "@validation/primitives/v";
import { getScalarSchemas } from "@validation/scalars";
import { isRecord } from "@validation/value-guards";
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

/** Construct, for a refusal the constructor is meant to throw. */
const construct = (value: string): Decimal => new Decimal(value);

const inDomain = (
  precision: number,
  scale: number,
  value: unknown
): { value: string } | { issues: unknown[] } =>
  v.decimal({ decimal: { precision, scale } })["~standard"].validate(value) as
    | { value: string }
    | { issues: unknown[] };

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

  test("refuses in the value module's words, one grammar for both boundaries", () => {
    // Two boundaries over one string grammar: `v.decimal()` returns issues and
    // `new Decimal()` throws, and both refuse exactly where
    // `admitDecimal` answers `undefined`. The field's sentence is
    // the value module's, imported rather than copied; the constructor's names
    // one more member (a whole bigint) and the same spelling.
    const result = parse("1e3");
    if (!("issues" in result)) throw new Error("Expected `1e3` to be refused.");
    const [issue] = result.issues;
    if (!isRecord(issue) || typeof issue.message !== "string") {
      throw new Error("Expected an issue carrying a message.");
    }
    expect(issue.message).toBe(DECIMAL_INPUT_REFUSAL);
    expect(DECIMAL_INPUT_REFUSAL).toBe(
      "Expected an exact decimal: a Decimal or a string like '-12.345' (sign, digits, at most one dot, no exponent); a JavaScript number is a double and is not accepted"
    );
    expect(() => construct("1e3")).toThrow(DECIMAL_CONSTRUCTOR_REFUSAL);
  });

  test("refuses a number with one issue, whatever double it names", () => {
    // Each of these used to be spelled through `String(n)` and admitted,
    // including the exponent forms `1e+21` and `1e-7` and the float error of
    // `0.1 + 0.2`. A double is not an exact decimal, so the field refuses it
    // with the same one issue it gives every other non-decimal value.
    for (const input of [
      1.5,
      -42,
      0,
      -0,
      0.1 + 0.2,
      1e21,
      1e-7,
      -1.5e-8,
      1.2e22,
    ]) {
      expect(parse(input)).toEqual({
        issues: [{ message: DECIMAL_INPUT_REFUSAL }],
      });
    }
    expect(
      v
        .decimal({ decimal: { precision: 10, scale: 2 } })
        ["~standard"].validate(1.5)
    ).toEqual({ issues: [{ message: DECIMAL_INPUT_REFUSAL }] });
  });

  test("refuses a bigint: the field's input family is Decimal | string", () => {
    // Only the value type's constructor reads a bigint as a coefficient; a
    // field would make it a third input form no public type mentions.
    expect(refused(9007199254740993n)).toBe(true);
  });

  test("refuses a number list member at its index, and keeps an empty list", () => {
    const list = v.decimal({
      decimal: { precision: 10, scale: 2 },
      array: true,
    })["~standard"];
    expect(list.validate(["1.5", 2])).toEqual({
      issues: [{ message: DECIMAL_INPUT_REFUSAL, path: [1] }],
    });
    expect(list.validate([])).toEqual({ value: [] });
  });

  test("nullable and array options compose", () => {
    const nullable = v.decimal({ nullable: true })["~standard"].validate(null);
    expect(nullable).toEqual({ value: null });

    const list = v
      .decimal({ array: true })
      ["~standard"].validate(["1.10", "2", "-0"]);
    expect(list).toEqual({ value: ["1.1", "2", "0"] });

    const badList = v.decimal({ array: true })["~standard"].validate(["1e3"]);
    expect(badList).toHaveProperty("issues");
  });
});

describe("decimal value boundary", () => {
  test("accepts a Decimal and renders it exactly", () => {
    expect(accepted(new Decimal("1.2300"))).toBe("1.23");
    expect(accepted(new Decimal("-0"))).toBe("0");
    // The exponent STRING stays outside the grammar on both sides of the
    // boundary, so the constructor refuses it too.
    expect(accepted(new Decimal("1000000000000000000000"))).toBe(
      "1000000000000000000000"
    );
    expect(refused("1e21")).toBe(true);
    expect(() => new Decimal("1e21")).toThrow(TypeError);
    expect(accepted(new Decimal("9007199254740993"))).toBe("9007199254740993");
  });

  test("constructs no non-finite value at all", () => {
    // The refusal is the constructor's: there is no NaN Decimal and no infinite
    // Decimal to hand this codec, so `canonicalizeDecimal` never sees one and
    // the application learns about it at its own construction site. They are
    // numbers, so they are refused as every number is.
    expect(() => new Decimal(Number.NaN as never)).toThrow(TypeError);
    expect(() => new Decimal(Number.POSITIVE_INFINITY as never)).toThrow(
      TypeError
    );
    expect(() => new Decimal(Number.NEGATIVE_INFINITY as never)).toThrow(
      TypeError
    );
    expect(() => new Decimal("abc")).toThrow(TypeError);
  });

  test("admits what the constructor built, and nothing shaped like it", () => {
    // The witness is CONSTRUCTION, not shape: the private field is installed by
    // the constructor and by nothing else, so there is no representation to
    // forge and nothing to snapshot. A prototype-only object passes
    // `instanceof` and is still refused.
    const empty = Object.create(Decimal.prototype);
    expect(empty).toBeInstanceOf(Decimal);
    expect(refused(empty)).toBe(true);
    expect(canonicalDecimalText(empty)).toBeUndefined();

    // An ordinary object carrying the internals a decimal might have is not a
    // candidate either, in either direction.
    const ordinary = { s: 1, e: 0, c: [1] };
    expect(ordinary).not.toBeInstanceOf(Decimal);
    expect(refused(ordinary)).toBe(true);
    expect(canonicalDecimalText(ordinary)).toBeUndefined();

    // A SUBCLASS is admitted: the constructor ran, so the value is exact, and
    // branding the value type is what a custom schema is allowed to do.
    class Money extends Decimal {}
    expect(accepted(new Money("1.50"))).toBe("1.5");
  });

  test("refuses a wrapper around a Decimal, however faithful", () => {
    // A private field is not forwarded through a Proxy, so a proxy over a
    // Decimal is not a Decimal — including a revoked one, which answers the
    // brand check without trapping and is therefore a refusal rather than an
    // exception escaping the result parser.
    const value = new Decimal("1.5");
    expect(refused(new Proxy(value, {}))).toBe(true);
    const revocable = Proxy.revocable(value, {});
    revocable.revoke();
    expect(refused(revocable.proxy)).toBe(true);
    expect(canonicalDecimalText(revocable.proxy)).toBeUndefined();
    const hostile = new Proxy(value, {
      get() {
        throw new Error("get trap");
      },
      has() {
        throw new Error("has trap");
      },
    });
    expect(refused(hostile)).toBe(true);
  });

  test("an unconstructed Decimal-shaped value is refused at every boundary", () => {
    // `"NaN"` or an empty spelling would otherwise become the ONE private
    // representation cursors, row keys, cache keys, SQL literals and DDL
    // defaults are all keyed on.
    const forged = Object.assign(Object.create(Decimal.prototype), {
      s: 1,
      e: 0,
      c: [Number.NaN],
    });
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
    expect(canonicalDecimalText(forged)).toBeUndefined();
    expect(decodeWidenedSum(forged, 2)).toBeUndefined();
    // The descriptor cannot be the net: it reads "NaN" as three coefficient
    // digits and no fractional digit, so it finds nothing to refuse.
    expect(domainRefusal("NaN", 10, 2)).toBeUndefined();
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

  test("renders every digit position from the value's own parts", () => {
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

  test("carries no own property for an application to overwrite", () => {
    // The two fields are private, so a caller that assigns over the internals
    // a decimal library used to expose writes ordinary own properties that no
    // reader of this value ever consults.
    const value = toDecimal("1.234");
    expect(Object.keys(value)).toEqual([]);
    Object.assign(value, { s: -1, e: 9, c: [9] });
    expect(canonicalizeMaterializedDecimal(value)).toBe("1.234");
    expect(value.toString()).toBe("1.234");
  });

  test("canonicalDecimalText admits only the Decimal family", () => {
    // The custom-schema RETURN position: a string or a number there is a
    // different value family, not a spelling of the same one.
    expect(canonicalDecimalText(new Decimal("1.20"))).toBe("1.2");
    expect(canonicalDecimalText("1.2")).toBeUndefined();
    expect(canonicalDecimalText(1.2)).toBeUndefined();
    expect(
      canonicalDecimalText(Object.create(Decimal.prototype))
    ).toBeUndefined();
  });

  test("never consults mutable Decimal prototype renderers", () => {
    // ONE prototype object backs every instance, and it is an object an
    // application can write to. The codec reads the value's private fields
    // instead, so a patched renderer moves the application's own output and
    // never the canonical text cache keys, row keys, SQL literals and DDL
    // defaults are built from.
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
      expect(new Decimal("1").toString()).toBe("2");
      expect(JSON.stringify(new Decimal("1"))).toBe('"2"');
      expect(canonicalizeDecimal(new Decimal("1"))).toBe("1");
      expect(canonicalizeDecimal(new Decimal("-1"))).toBe("-1");
      expect(canonicalizeMaterializedDecimal(toDecimal("1"))).toBe("1");
      expect(canonicalizeMaterializedDecimal(toDecimal("-1"))).toBe("-1");
      expect(canonicalDecimalText(new Decimal("1.20"))).toBe("1.2");
    } finally {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) {
          Object.defineProperty(Decimal.prototype, name, descriptor);
        }
      }
    }
  });

  test("has nothing an application can configure", () => {
    // The whole class of "a global setting moved a stored value" defects is
    // gone by construction: there is no static to set, in either direction.
    expect(Object.getOwnPropertyNames(Decimal).sort()).toEqual([
      "length",
      "name",
      "prototype",
    ]);
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
    // A double that already lost the value is refused before the domain is
    // asked, as every number is.
    expect(inDomain(10, 2, 0.1 + 0.2)).toEqual({
      issues: [{ message: DECIMAL_INPUT_REFUSAL }],
    });
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
    expect(domainRefusal("1.005", 10, 2)).toBe(
      "Expected at most 2 fractional digits, but '1.005' has 3"
    );
    expect(domainRefusal("0.05", 10, 1)).toBe(
      "Expected at most 1 fractional digit, but '0.05' has 2"
    );
    expect(domainRefusal("100000", 10, 5)).toBe(
      "Expected an unscaled coefficient of at most 10 digits, but '100000' needs 11"
    );
    expect(domainRefusal("1.2", 10, 5)).toBeUndefined();
    // The count reads the text: an integer part counts every digit, a zero
    // integer part counts from the first non-zero fraction digit, zero none.
    expect(domainRefusal("123456789.1", 10, 2)).toBe(
      "Expected an unscaled coefficient of at most 10 digits, but '123456789.1' needs 11"
    );
    expect(domainRefusal("-0.001", 3, 3)).toBeUndefined();
    expect(domainRefusal("0.001", 2, 3)).toBeUndefined();
    expect(domainRefusal("0.01", 1, 3)).toBe(
      "Expected an unscaled coefficient of at most 1 digits, but '0.01' needs 2"
    );
    expect(domainRefusal("0", 1, Number.MAX_SAFE_INTEGER)).toBeUndefined();
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
    expect((seen[0] as Decimal).toString()).toBe("1.5");
  });

  test("the declared domain validates whatever the schema returned, LAST", () => {
    // A schema that widens the value cannot escape the field's domain.
    const schema = v.decimal({
      decimal: { precision: 10, scale: 2 },
      schema: observe(() => ({ value: new Decimal("1.005") })),
    });
    expect(schema["~standard"].validate("1.00")).toHaveProperty("issues");
  });

  test("refuses a return that is not a Decimal", () => {
    // Three arms, because the family is decided by construction: a string, a
    // number, and a value wearing the prototype the constructor never ran for.
    for (const returned of ["1.5", 1.5, Object.create(Decimal.prototype)]) {
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
    expect(schema["~standard"].validate(1.5)).toEqual({
      issues: [{ message: DECIMAL_INPUT_REFUSAL }],
    });
    expect(schema["~standard"].validate("1.50")).toEqual({ value: "1.5" });
    expect(schema["~standard"].validate(new Decimal("1.5"))).toEqual({
      value: "1.5",
    });
  });
});

/** A coefficient decode with a bound no case below reaches. */
const coefficientToLogical = (coefficient: unknown, scale: number) =>
  decodePhysicalDecimal(coefficient, { precision: 1000, scale }, "coefficient");

describe("logical and coefficient conversion", () => {
  test("shifts the value's own coefficient, never a JavaScript number", () => {
    expect(logicalToCoefficient("1.2", 2)).toBe("120");
    expect(logicalToCoefficient("-0.03", 2)).toBe("-3");
    expect(logicalToCoefficient("0", 2)).toBe("0");
    expect(logicalToCoefficient("0", 0)).toBe("0");
    expect(logicalToCoefficient("-12345", 0)).toBe("-12345");
    expect(logicalToCoefficient("-1.2", 5)).toBe("-120000");
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
    // `BigInt` itself reads `"0x10"`, `" 1 "`, `"1 "` and `""`: the vocabulary
    // is refused before a number is built.
    for (const bad of [
      "+1",
      "-",
      "-0",
      "01",
      "0120",
      "1.0",
      "1e3",
      "",
      " 1",
      "1 ",
      "0x10",
      "abc",
      120,
      1n,
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
    expect(coefficientZero?.eq("0")).toBe(true);
    // Zero has no sign to carry: the canonical spelling the codec hands the
    // constructor is "0", and the value renders it back unsigned.
    expect(coefficientZero?.toString()).toBe("0");
    expect(zero?.eq("0")).toBe(true);
    expect(zero?.toString()).toBe("0");
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

describe("the documented value surface", () => {
  /**
   * The migration note is the only inventory an application has of the value
   * surface it is porting to, and the class is now VibORM's own — so the note
   * and the prototype are two spellings of one fact and either can drift from
   * the other. An earlier note claimed 25 methods and listed 24 names, silently
   * omitting three that a reader then ported away from as removals.
   */
  const noteSection = (marker: string): string => {
    const changelog = readFileSync(
      join(REPOSITORY_ROOT, "CHANGELOG.md"),
      "utf8"
    );
    const start = changelog.indexOf(marker);
    if (start < 0) throw new Error(`CHANGELOG has no ${marker} inventory`);
    const end = changelog.indexOf("\n- ", start);
    return changelog.slice(start, end < 0 ? changelog.length : end);
  };

  /** Every BARE name in backticks: `x.isZero()` and `x.s < 0` are prose. */
  const documentedNames = (section: string): Set<string> =>
    new Set(
      [...section.matchAll(/`([A-Za-z][A-Za-z0-9]*)`/g)].map(
        (match) => match[1] as string
      )
    );

  const prototypeMembers = new Set(
    Object.getOwnPropertyNames(Decimal.prototype).filter(
      (name) => name !== "constructor"
    )
  );

  test("lists exactly the prototype VibORM ships", () => {
    expect([...documentedNames(noteSection("Kept:"))].sort()).toEqual(
      [...prototypeMembers].sort()
    );
  });

  test("calls gone only what the value type genuinely dropped", () => {
    const gone = [...documentedNames(noteSection("- **Gone:**"))];
    expect(gone.length).toBeGreaterThan(0);
    expect(gone.filter((name) => prototypeMembers.has(name))).toEqual([]);
  });
});
