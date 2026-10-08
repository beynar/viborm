import { Decimal, s } from "@src/index";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { parse } from "@validation";
import { getScalarSchemas } from "@validation/scalars";
import { describe, expect, it } from "vitest";

const positive: StandardSchemaV1<number> = {
  "~standard": {
    version: 1,
    vendor: "v1",
    validate(value) {
      return typeof value === "number" && value > 0
        ? { value }
        : { issues: [{ message: "positive required" }] };
    },
  },
};

describe("V1 refinement admission boundaries", () => {
  it("canonicalizes temporal custom outputs without repeating the write schema", () => {
    for (const output of [
      new Date("2024-06-01T10:30:00Z"),
      "2024-06-01T12:30:00+02:00",
    ]) {
      let calls = 0;
      const dishonest: StandardSchemaV1<string> = {
        "~standard": {
          version: 1,
          vendor: "v1",
          validate: new Proxy(
            (value: unknown) =>
              typeof value === "string"
                ? { value }
                : { issues: [{ message: "string" }] },
            {
              apply() {
                calls++;
                return { value: output };
              },
            }
          ),
        },
      };
      const schemas = getScalarSchemas(
        s.dateTime().schema(dishonest)["~"].state
      );
      expect(parse(schemas.create, "2024-01-01T00:00:00Z")).toEqual({
        value: "2024-06-01T10:30:00.000Z",
      });
      expect(calls).toBe(1);
    }
  });
  it("refuses zero divisors for every ordinary numeric field before provider SQL", () => {
    for (const field of [
      s.int(),
      s.int().nullable(),
      s.number(),
      s.number().nullable(),
      s.bigInt(),
    ]) {
      const update = getScalarSchemas(field["~"].state).update;
      const zero = field["~"].state.type === "bigint" ? 0n : 0;
      const one = field["~"].state.type === "bigint" ? 1n : 1;
      expect(parse(update, { divide: zero }).issues?.[0]?.message).toContain(
        "Division by zero"
      );
      expect(parse(update, { divide: one }).issues).toBeUndefined();
      expect(parse(update, { set: zero }).issues).toBeUndefined();
    }
  });
  it("refuses arithmetic whose resulting value cannot be validated", () => {
    for (const field of [
      s.int().schema(positive),
      s.number().schema(positive),
    ]) {
      const update = getScalarSchemas(field["~"].state).update;
      expect(parse(update, { set: 2 }).issues).toBeUndefined();
      expect(parse(update, { set: -2 }).issues).toBeDefined();
      for (const operation of [
        "increment",
        "decrement",
        "multiply",
        "divide",
      ]) {
        expect(
          parse(update, { [operation]: 2 }).issues?.[0]?.message
        ).toContain("resulting stored value");
      }
    }
  });

  it("validates every list member after either modifier order", () => {
    for (const field of [
      s.int().schema(positive).array(),
      s.number().array().schema(positive).nullable(),
    ]) {
      const update = getScalarSchemas(field["~"].state).update;
      for (const operation of ["push", "unshift"]) {
        expect(parse(update, { [operation]: [1, -2] }).issues).toBeDefined();
        expect(parse(update, { [operation]: -2 }).issues).toBeDefined();
        expect(parse(update, { [operation]: [1, 2] }).issues).toBeUndefined();
      }
    }
  });

  it("transforms write members once while filters consume stored values", () => {
    let calls = 0;
    const plusTen: StandardSchemaV1<number> = {
      "~standard": {
        version: 1,
        vendor: "v1",
        validate(value) {
          calls++;
          return typeof value === "number"
            ? { value: value + 10 }
            : { issues: [{ message: "number" }] };
        },
      },
    };
    const schemas = getScalarSchemas(s.number().schema(plusTen)["~"].state);
    expect(parse(schemas.create, 1)).toEqual({ value: 11 });
    expect(parse(schemas.filter, { equals: 11 })).toEqual({
      value: { equals: 11 },
    });
    expect(
      parse(schemas.filter, { not: { equals: 11 } }).issues
    ).toBeUndefined();
    expect(calls).toBe(1);
    const list = getScalarSchemas(
      s.number().schema(plusTen).array()["~"].state
    );
    expect(parse(list.update, { push: [1, 2] })).toEqual({
      value: { push: [11, 12] },
    });
    expect(calls).toBe(3);
    expect(parse(list.filter, { equals: [11, 12] })).toEqual({
      value: { equals: [11, 12] },
    });
    expect(calls).toBe(3);
  });

  it("does not repeat string transforms in shorthand, equality or membership", () => {
    let calls = 0;
    const append: StandardSchemaV1<string> = {
      "~standard": {
        version: 1,
        vendor: "v1",
        validate(value) {
          calls++;
          return typeof value === "string"
            ? { value: `${value}!` }
            : { issues: [{ message: "string" }] };
        },
      },
    };
    const schemas = getScalarSchemas(s.string().schema(append)["~"].state);
    expect(parse(schemas.create, "one")).toEqual({ value: "one!" });
    expect(parse(schemas.filter, "one!")).toEqual({
      value: { equals: "one!" },
    });
    expect(parse(schemas.filter, { equals: "one!", in: ["one!"] })).toEqual({
      value: { in: ["one!"], equals: "one!" },
    });
    const list = getScalarSchemas(s.string().schema(append).array()["~"].state);
    expect(parse(list.update, { unshift: ["two", "three"] })).toEqual({
      value: { unshift: ["two!", "three!"] },
    });
    expect(calls).toBe(3);
  });

  it("keeps identifier admission and canonicalization without invoking write schema", () => {
    let calls = 0;
    const identity: StandardSchemaV1<string> = {
      "~standard": {
        version: 1,
        vendor: "v1",
        validate(value) {
          calls++;
          return typeof value === "string"
            ? { value }
            : { issues: [{ message: "string" }] };
        },
      },
    };
    const filter = getScalarSchemas(
      s.string().uuid().schema(identity)["~"].state
    ).filter;
    expect(
      parse(filter, { equals: "550E8400-E29B-41D4-A716-446655440000" }).issues
    ).toBeUndefined();
    expect(parse(filter, { equals: "bad" }).issues).toBeDefined();
    expect(calls).toBe(0);
  });

  it("keeps bigint write refinements and physical filter operands", () => {
    const aboveZero: StandardSchemaV1<bigint> = {
      "~standard": {
        version: 1,
        vendor: "v1",
        validate(value) {
          return typeof value === "bigint" && value > 0n
            ? { value }
            : { issues: [{ message: "positive bigint" }] };
        },
      },
    };
    const scalar = s.bigInt().schema(aboveZero);
    const schemas = getScalarSchemas(scalar["~"].state);
    expect(parse(schemas.update, { decrement: 1n }).issues).toBeDefined();
    expect(parse(schemas.filter, { equals: -1n }).issues).toBeUndefined();
    expect(
      parse(getScalarSchemas(scalar.array()["~"].state).update, { push: [-1n] })
        .issues
    ).toBeDefined();
  });

  it("does not run temporal write transforms during comparisons", () => {
    let calls = 0;
    const identity: StandardSchemaV1<string> = {
      "~standard": {
        version: 1,
        vendor: "v1",
        validate(value) {
          calls++;
          return typeof value === "string"
            ? { value }
            : { issues: [{ message: "temporal" }] };
        },
      },
    };
    for (const [field, value] of [
      [s.dateTime().schema(identity), "2026-01-01T00:00:00.000Z"],
      [s.date().schema(identity), "2026-01-01"],
      [s.time().schema(identity), "12:00:00"],
    ] as const) {
      const schemas = getScalarSchemas(field["~"].state);
      expect(parse(schemas.filter, { equals: value }).issues).toBeUndefined();
      expect(parse(schemas.filter, { gt: value }).issues).toBeUndefined();
      expect(
        parse(getScalarSchemas(field.array()["~"].state).update, {
          push: value,
        }).issues
      ).toBeUndefined();
    }
    expect(calls).toBe(3);
  });

  it("applies decimal refinements to pushed members, refuses arithmetic and trusts filter domain", () => {
    let calls = 0;
    const aboveZero: StandardSchemaV1<Decimal> = {
      "~standard": {
        version: 1,
        vendor: "v1",
        validate(value) {
          calls++;
          return value instanceof Decimal && value.gt(0n)
            ? { value }
            : { issues: [{ message: "positive decimal" }] };
        },
      },
    };
    const scalar = s.decimal({ precision: 10, scale: 2 }).schema(aboveZero);
    const schemas = getScalarSchemas(scalar["~"].state);
    expect(
      parse(schemas.update, { increment: "1.00" }).issues?.[0]?.message
    ).toContain("resulting stored value");
    expect(parse(schemas.filter, { equals: "-1.00" }).issues).toBeUndefined();
    expect(calls).toBe(0);
    const update = getScalarSchemas(scalar.array()["~"].state).update;
    expect(parse(update, { push: ["1.00", "-1.00"] }).issues).toBeDefined();
    expect(parse(update, { unshift: "1.00" }).issues).toBeUndefined();
    expect(calls).toBe(3);
  });

  it("refuses hostile ordinary-schema output before ORM write admission", () => {
    const hostile = <T>(value: T, output: unknown): StandardSchemaV1<T> => {
      const trusted: StandardSchemaV1<T> = {
        "~standard": { version: 1, vendor: "v1", validate: () => ({ value }) },
      };
      return new Proxy(trusted, {
        get(target, key, receiver) {
          if (key === "~standard")
            return {
              ...target["~standard"],
              validate: () => ({ value: output }),
            };
          return Reflect.get(target, key, receiver);
        },
      });
    };
    for (const [field, value] of [
      [s.number().schema(hostile(1, "not a number")), 1],
      [s.int().schema(hostile(1, 1.5)), 1],
      [s.bigInt().schema(hostile(1n, "not a bigint")), 1n],
      [s.string().schema(hostile("value", 1)), "value"],
      [
        s
          .dateTime()
          .schema(
            hostile("2026-01-01T00:00:00.000Z", "2026-02-30T00:00:00.000Z")
          ),
        "2026-01-01T00:00:00.000Z",
      ],
      [s.date().schema(hostile("2026-01-01", "2026-02-30")), "2026-01-01"],
      [s.time().schema(hostile("12:00:00", "25:00:00")), "12:00:00"],
    ] as const) {
      // The uncomposed base reproduces the old trust gap at the same boundary.
      expect(parse(field["~"].state.base, value).issues).toBeUndefined();
      const schemas = getScalarSchemas(field["~"].state);
      expect(parse(schemas.create, value).issues).toBeDefined();
      expect(parse(schemas.update, { set: value }).issues).toBeDefined();
      expect(
        parse(getScalarSchemas(field.array()["~"].state).update, {
          push: value,
        }).issues
      ).toBeDefined();
    }
  });
});
