import type { StandardSchemaV1 } from "@standard-schema/spec";
import v, { parse } from "@validation";
import { describe, expect, expectTypeOf, test } from "vitest";

describe("point schema", () => {
  describe("basic validation", () => {
    const schema = v.point();

    test("validates point objects", () => {
      const result = parse(schema, { x: 1, y: 2 });
      expect(result.issues).toBeUndefined();
      expect((result as { value: { x: number; y: number } }).value).toEqual({
        x: 1,
        y: 2,
      });
    });

    test("rejects missing x", () => {
      const result = parse(schema, { y: 2 });
      expect(result.issues).toBeDefined();
      expect(result.issues?.[0]?.message).toContain("x");
    });

    test("rejects missing y", () => {
      const result = parse(schema, { x: 1 });
      expect(result.issues).toBeDefined();
      expect(result.issues?.[0]?.message).toContain("y");
    });

    test("rejects non-numbers", () => {
      expect(parse(schema, { x: "1", y: 2 }).issues).toBeDefined();
      expect(parse(schema, { x: 1, y: "2" }).issues).toBeDefined();
    });

    test("rejects non-objects", () => {
      expect(parse(schema, null).issues).toBeDefined();
      expect(parse(schema, undefined).issues).toBeDefined();
      expect(parse(schema, [1, 2]).issues).toBeDefined();
    });

    test("rejects arrays with forged coordinate properties", () => {
      const forged = Object.assign([], { x: 1, y: 2 });

      expect(parse(schema, forged).issues).toBeDefined();
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toMatchTypeOf<{ x: number; y: number }>();
    });
  });

  describe("optional option", () => {
    const schema = v.point({ optional: true });

    test("allows undefined", () => {
      const result = parse(schema, undefined);
      expect(result.issues).toBeUndefined();
    });
  });

  describe("nullable option", () => {
    const schema = v.point({ nullable: true });

    test("allows null", () => {
      const result = parse(schema, null);
      expect(result.issues).toBeUndefined();
    });
  });

  describe("array option", () => {
    const schema = v.point({ array: true });

    test("validates array of points", () => {
      const result = parse(schema, [
        { x: 1, y: 2 },
        { x: 3, y: 4 },
      ]);
      expect(result.issues).toBeUndefined();
    });
  });
});
