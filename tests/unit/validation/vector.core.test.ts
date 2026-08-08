import type { StandardSchemaV1 } from "@standard-schema/spec";
import v, { parse } from "@validation";
import { describe, expect, expectTypeOf, test } from "vitest";

describe("vector schema", () => {
  describe("basic validation", () => {
    const schema = v.vector();

    test("validates array of numbers", () => {
      const result = parse(schema, [1, 2, 3]);
      expect(result.issues).toBeUndefined();
      expect((result as { value: number[] }).value).toEqual([1, 2, 3]);
    });

    test("validates empty array", () => {
      const result = parse(schema, []);
      expect(result.issues).toBeUndefined();
      expect((result as { value: number[] }).value).toEqual([]);
    });

    test("rejects non-arrays", () => {
      expect(parse(schema, 1).issues).toBeDefined();
      expect(parse(schema, "vector").issues).toBeDefined();
    });

    test("rejects array with non-numbers", () => {
      const result = parse(schema, [1, "2", 3]);
      expect(result.issues).toBeDefined();
      expect(result.issues?.[0]?.message).toContain("number");
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toMatchTypeOf<number[]>();
    });
  });

  describe("fixed length", () => {
    const schema = v.vector(3);

    test("validates vector of exact length", () => {
      const result = parse(schema, [1, 2, 3]);
      expect(result.issues).toBeUndefined();
    });

    test("rejects wrong length", () => {
      expect(parse(schema, [1, 2]).issues).toBeDefined();
      expect(parse(schema, [1, 2, 3, 4]).issues).toBeDefined();
    });

    test("validates empty array when length is 0", () => {
      const zeroSchema = v.vector(0);
      const result = parse(zeroSchema, []);
      expect(result.issues).toBeUndefined();
    });
  });

  describe("optional option", () => {
    const schema = v.vector(undefined, { optional: true });

    test("allows undefined", () => {
      const result = parse(schema, undefined);
      expect(result.issues).toBeUndefined();
    });
  });

  describe("nullable option", () => {
    const schema = v.vector(undefined, { nullable: true });

    test("allows null", () => {
      const result = parse(schema, null);
      expect(result.issues).toBeUndefined();
    });
  });

  describe("array option", () => {
    const schema = v.vector(undefined, { array: true });

    test("validates array of vectors", () => {
      const result = parse(schema, [
        [1, 2],
        [3, 4],
      ]);
      expect(result.issues).toBeUndefined();
    });
  });
});
