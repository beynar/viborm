import type { StandardSchemaV1 } from "@standard-schema/spec";
import { parse, v } from "@validation";
import { describe, expect, test, vi } from "vitest";

describe("scalar modifier combinations", () => {
  test.each([
    [{}, "value"],
    [{ array: true }, ["value"]],
    [{ optional: true }, undefined],
    [{ optional: true, array: true }, undefined],
    [{ nullable: true }, null],
    [{ nullable: true, array: true }, null],
    [{ nullable: true, optional: true }, undefined],
    [{ nullable: true, optional: true, array: true }, null],
  ] as const)("composes options %j", (options, accepted) => {
    const schema = v.string(options);
    const isArray = "array" in options && options.array;

    expect(parse(schema, accepted).issues).toBeUndefined();
    expect(parse(schema, isArray ? [1] : 1)).toEqual(
      isArray
        ? { issues: [{ message: "Expected string", path: [0] }] }
        : { issues: [{ message: "Expected string" }] }
    );
  });

  test("applies scalar and array defaults across nullability", () => {
    const scalar = v.string({ nullable: true, default: "fallback" });
    const array = v.string({ array: true, default: ["fallback"] });
    const nullableArray = v.string({
      array: true,
      nullable: true,
      default: ["fallback"],
    });

    expect(parse(scalar, undefined)).toEqual({ value: "fallback" });
    expect(parse(scalar, null)).toEqual({ value: null });
    expect(parse(scalar, "value")).toEqual({ value: "value" });
    expect(parse(array, undefined)).toEqual({ value: ["fallback"] });
    expect(parse(array, ["value"])).toEqual({ value: ["value"] });
    expect(parse(nullableArray, undefined)).toEqual({ value: ["fallback"] });
    expect(parse(nullableArray, null)).toEqual({ value: null });
    expect(parse(nullableArray, ["value"])).toEqual({ value: ["value"] });
  });

  test("contains external schema and transform failures as issues", () => {
    const external: StandardSchemaV1<string, string> = {
      "~standard": {
        version: 1,
        vendor: "external",
        validate: (value) =>
          value === "accepted"
            ? { value: value.toUpperCase() }
            : { issues: [{ message: "external refusal" }] },
      },
    };
    const transform = vi.fn((value: string) => `${value}!`);
    const schema = v.string({ schema: external, transform });

    expect(parse(schema, "accepted")).toEqual({ value: "ACCEPTED!" });
    expect(parse(schema, "refused").issues?.[0]?.message).toBe(
      "external refusal"
    );
    expect(parse(schema, 1)).toEqual({
      issues: [{ message: "Expected string" }],
    });
    expect(transform).toHaveBeenCalledTimes(1);

    const throwing = v.string({
      transform: () => {
        throw new Error("transform exploded");
      },
    });
    expect(parse(throwing, "value").issues?.[0]?.message).toBe(
      "Transform failed: transform exploded"
    );

    const throwingValue = v.string({
      transform: () => {
        // biome-ignore lint/style/useThrowOnlyError: hostile user callbacks may throw any value
        throw "transform refused";
      },
    });
    expect(parse(throwingValue, "value").issues?.[0]?.message).toBe(
      "Transform failed: transform refused"
    );
  });

  test("composes object wrappers without changing object validation", () => {
    const entry = { name: v.string() };
    const optionalArray = v.object(entry, { array: true, optional: true });
    const defaultArray = v.object(entry, {
      array: true,
      optional: true,
      default: [{ name: "fallback" }],
    });
    const nullableArray = v.object(entry, {
      array: true,
      nullable: true,
      optional: true,
    });
    const nullable = v.object(entry, { nullable: true });

    expect(parse(optionalArray, undefined)).toEqual({ value: undefined });
    expect(parse(defaultArray, undefined)).toEqual({
      value: [{ name: "fallback" }],
    });
    expect(parse(nullableArray, undefined)).toEqual({ value: undefined });
    expect(parse(nullableArray, null)).toEqual({ value: null });
    expect(parse(nullable, { name: "value" }).issues).toBeUndefined();
    expect(parse(nullable, null)).toEqual({ value: null });
  });

  test("refuses asynchronous external scalar schemas", () => {
    const external = {
      "~standard": {
        version: 1 as const,
        vendor: "external",
        validate: async (value: unknown) =>
          typeof value === "string"
            ? { value }
            : { issues: [{ message: "Expected string" }] },
      },
    } satisfies StandardSchemaV1<string, string>;

    expect(
      parse(v.string({ schema: external }), "value").issues?.[0]?.message
    ).toBe("Async schemas are not supported");
  });

  test("enforces the portable auto-increment zero rule after type validation", () => {
    const zeroMessage =
      "Explicit zero is not portable for an auto-increment field";

    expect(parse(v.integer({ disallowZero: true }), 0)).toEqual({
      issues: [{ message: zeroMessage }],
    });
    expect(parse(v.integer({ disallowZero: true }), 1)).toEqual({ value: 1 });
    expect(parse(v.integer({ disallowZero: true }), "0")).toEqual({
      issues: [{ message: "Expected integer" }],
    });
    expect(parse(v.bigint({ disallowZero: true }), 0n)).toEqual({
      issues: [{ message: zeroMessage }],
    });
  });
});
