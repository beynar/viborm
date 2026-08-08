import type { StandardSchemaV1 } from "@standard-schema/spec";
import v, { parse } from "@validation";
import { describe, expect, expectTypeOf, test } from "vitest";

describe("boolean schema", () => {
  describe("basic validation", () => {
    const schema = v.boolean();

    test("validates true", () => {
      const result = parse(schema, true);
      expect(result.issues).toBeUndefined();
      expect((result as { value: boolean }).value).toBe(true);
    });

    test("validates false", () => {
      const result = parse(schema, false);
      expect(result.issues).toBeUndefined();
      expect((result as { value: boolean }).value).toBe(false);
    });

    test("rejects truthy numbers", () => {
      const result = parse(schema, 1);
      expect(result.issues).toBeDefined();
    });

    test("rejects falsy numbers", () => {
      const result = parse(schema, 0);
      expect(result.issues).toBeDefined();
    });

    test("rejects strings", () => {
      const result = parse(schema, "true");
      expect(result.issues).toBeDefined();
    });

    test("rejects null", () => {
      const result = parse(schema, null);
      expect(result.issues).toBeDefined();
    });

    test("rejects undefined", () => {
      const result = parse(schema, undefined);
      expect(result.issues).toBeDefined();
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      type Input = StandardSchemaV1.InferInput<typeof schema>;
      expectTypeOf<Output>().toMatchTypeOf<boolean>();
      expectTypeOf<Input>().toMatchTypeOf<boolean>();
    });
  });

  describe("optional option", () => {
    const schema = v.boolean({ optional: true });

    test("allows undefined", () => {
      const result = parse(schema, undefined);
      expect(result.issues).toBeUndefined();
      expect((result as { value: boolean | undefined }).value).toBeUndefined();
    });

    test("validates booleans", () => {
      expect(parse(schema, true).issues).toBeUndefined();
      expect(parse(schema, false).issues).toBeUndefined();
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toMatchTypeOf<boolean | undefined>();
    });
  });

  describe("nullable option", () => {
    const schema = v.boolean({ nullable: true });

    test("allows null", () => {
      const result = parse(schema, null);
      expect(result.issues).toBeUndefined();
      expect((result as { value: boolean | null }).value).toBeNull();
    });

    test("validates booleans", () => {
      expect(parse(schema, true).issues).toBeUndefined();
      expect(parse(schema, false).issues).toBeUndefined();
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toMatchTypeOf<boolean | null>();
    });
  });

  describe("array option", () => {
    const schema = v.boolean({ array: true });

    test("validates array of booleans", () => {
      const result = parse(schema, [true, false, true]);
      expect(result.issues).toBeUndefined();
      expect((result as { value: boolean[] }).value).toEqual([
        true,
        false,
        true,
      ]);
    });

    test("validates empty array", () => {
      const result = parse(schema, []);
      expect(result.issues).toBeUndefined();
      expect((result as { value: boolean[] }).value).toEqual([]);
    });

    test("rejects non-arrays", () => {
      const result = parse(schema, true);
      expect(result.issues).toBeDefined();
    });

    test("rejects array with invalid items", () => {
      const result = parse(schema, [true, "false", false]);
      expect(result.issues).toBeDefined();
      expect(result.issues?.[0]?.path).toEqual([1]);
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toMatchTypeOf<boolean[]>();
    });
  });

  describe("default option", () => {
    test("static default", () => {
      const schema = v.boolean({ default: false });
      const result = parse(schema, undefined);
      expect(result.issues).toBeUndefined();
      expect((result as { value: boolean }).value).toBe(false);
    });

    test("default factory function", () => {
      let toggle = false;
      const schema = v.boolean({ default: () => (toggle = !toggle) });
      expect((parse(schema, undefined) as { value: boolean }).value).toBe(true);
      expect((parse(schema, undefined) as { value: boolean }).value).toBe(
        false
      );
    });
  });

  describe("transform option", () => {
    const schema = v.boolean({ transform: (b) => !b } as any);

    test("applies transform to output", () => {
      const result = parse(schema, true);
      expect(result.issues).toBeUndefined();
      expect((result as { value: boolean }).value).toBe(false);
    });
  });

  describe("combined options", () => {
    test("optional + nullable", () => {
      const schema = v.boolean({ optional: true, nullable: true });
      expect(parse(schema, undefined).issues).toBeUndefined();
      expect(parse(schema, null).issues).toBeUndefined();
      expect(parse(schema, true).issues).toBeUndefined();
    });

    test("array + optional", () => {
      const schema = v.boolean({ array: true, optional: true });
      expect(parse(schema, undefined).issues).toBeUndefined();
      expect(parse(schema, [true]).issues).toBeUndefined();
    });
  });
});
