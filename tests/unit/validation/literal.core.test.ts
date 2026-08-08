import type { StandardSchemaV1 } from "@standard-schema/spec";
import v, { parse } from "@validation";
import { describe, expect, expectTypeOf, test } from "vitest";

describe("literal schema", () => {
  describe("string literals", () => {
    const schema = v.literal("admin");

    test("validates exact match", () => {
      const result = parse(schema, "admin");
      expect(result.issues).toBeUndefined();
      expect((result as { value: "admin" }).value).toBe("admin");
    });

    test("rejects non-match", () => {
      const result = parse(schema, "user");
      expect(result.issues).toBeDefined();
    });

    test("rejects similar strings", () => {
      expect(parse(schema, "Admin").issues).toBeDefined();
      expect(parse(schema, "admin ").issues).toBeDefined();
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toMatchTypeOf<"admin">();
    });
  });

  describe("number literals", () => {
    const schema = v.literal(42);

    test("validates exact match", () => {
      const result = parse(schema, 42);
      expect(result.issues).toBeUndefined();
      expect((result as { value: 42 }).value).toBe(42);
    });

    test("rejects different numbers", () => {
      expect(parse(schema, 41).issues).toBeDefined();
      expect(parse(schema, 43).issues).toBeDefined();
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toMatchTypeOf<42>();
    });
  });

  describe("boolean literals", () => {
    test("true literal", () => {
      const schema = v.literal(true);
      expect(parse(schema, true).issues).toBeUndefined();
      expect(parse(schema, false).issues).toBeDefined();
    });

    test("false literal", () => {
      const schema = v.literal(false);
      expect(parse(schema, false).issues).toBeUndefined();
      expect(parse(schema, true).issues).toBeDefined();
    });
  });

  test("null literal reports its readable spelling", () => {
    const schema = v.literal(null);

    expect(parse(schema, null).issues).toBeUndefined();
    expect(parse(schema, "null").issues?.[0]?.message).toBe(
      "Expected literal: null"
    );
  });

  describe("optional option", () => {
    const schema = v.literal("admin", { optional: true });

    test("allows undefined", () => {
      const result = parse(schema, undefined);
      expect(result.issues).toBeUndefined();
    });

    test("validates literal", () => {
      const result = parse(schema, "admin");
      expect(result.issues).toBeUndefined();
    });
  });

  describe("nullable option", () => {
    const schema = v.literal("admin", { nullable: true });

    test("allows null", () => {
      const result = parse(schema, null);
      expect(result.issues).toBeUndefined();
    });

    test("validates literal", () => {
      const result = parse(schema, "admin");
      expect(result.issues).toBeUndefined();
    });
  });

  describe("array option", () => {
    const schema = v.literal("admin", { array: true });

    test("validates array of literals", () => {
      const result = parse(schema, ["admin", "admin"]);
      expect(result.issues).toBeUndefined();
      expect((result as { value: "admin"[] }).value).toEqual([
        "admin",
        "admin",
      ]);
    });

    test("rejects array with non-matching items", () => {
      const result = parse(schema, ["admin", "user"]);
      expect(result.issues).toBeDefined();
    });
  });

  describe("default option", () => {
    const schema = v.literal("admin", { default: "admin" });

    test("provides default", () => {
      const result = parse(schema, undefined);
      expect(result.issues).toBeUndefined();
      expect((result as { value: "admin" }).value).toBe("admin");
    });
  });
});
