import { describe, test, expect, expectTypeOf } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { v, boolean } from "@validation";

describe("boolean schema", () => {
  describe("basic validation", () => {
    const schema = boolean();

    test("validates true", () => {
      const result = schema["~standard"].validate(true);
      expect(result.issues).toBeUndefined();
      expect((result as { value: boolean }).value).toBe(true);
    });

    test("validates false", () => {
      const result = schema["~standard"].validate(false);
      expect(result.issues).toBeUndefined();
      expect((result as { value: boolean }).value).toBe(false);
    });

    test("rejects truthy numbers", () => {
      const result = schema["~standard"].validate(1);
      expect(result.issues).toBeDefined();
    });

    test("rejects falsy numbers", () => {
      const result = schema["~standard"].validate(0);
      expect(result.issues).toBeDefined();
    });

    test("rejects strings", () => {
      const result = schema["~standard"].validate("true");
      expect(result.issues).toBeDefined();
    });

    test("rejects null", () => {
      const result = schema["~standard"].validate(null);
      expect(result.issues).toBeDefined();
    });

    test("rejects undefined", () => {
      const result = schema["~standard"].validate(undefined);
      expect(result.issues).toBeDefined();
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      type Input = StandardSchemaV1.InferInput<typeof schema>;
      expectTypeOf<Output>().toEqualTypeOf<boolean>();
      expectTypeOf<Input>().toEqualTypeOf<boolean>();
    });
  });

  describe("optional option", () => {
    const schema = boolean({ optional: true });

    test("allows undefined", () => {
      const result = schema["~standard"].validate(undefined);
      expect(result.issues).toBeUndefined();
      expect((result as { value: boolean | undefined }).value).toBeUndefined();
    });

    test("validates booleans", () => {
      expect(schema["~standard"].validate(true).issues).toBeUndefined();
      expect(schema["~standard"].validate(false).issues).toBeUndefined();
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toEqualTypeOf<boolean | undefined>();
    });
  });

  describe("nullable option", () => {
    const schema = boolean({ nullable: true });

    test("allows null", () => {
      const result = schema["~standard"].validate(null);
      expect(result.issues).toBeUndefined();
      expect((result as { value: boolean | null }).value).toBeNull();
    });

    test("validates booleans", () => {
      expect(schema["~standard"].validate(true).issues).toBeUndefined();
      expect(schema["~standard"].validate(false).issues).toBeUndefined();
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toEqualTypeOf<boolean | null>();
    });
  });

  describe("array option", () => {
    const schema = boolean({ array: true });

    test("validates array of booleans", () => {
      const result = schema["~standard"].validate([true, false, true]);
      expect(result.issues).toBeUndefined();
      expect((result as { value: boolean[] }).value).toEqual([
        true,
        false,
        true,
      ]);
    });

    test("validates empty array", () => {
      const result = schema["~standard"].validate([]);
      expect(result.issues).toBeUndefined();
      expect((result as { value: boolean[] }).value).toEqual([]);
    });

    test("rejects non-arrays", () => {
      const result = schema["~standard"].validate(true);
      expect(result.issues).toBeDefined();
    });

    test("rejects array with invalid items", () => {
      const result = schema["~standard"].validate([true, "false", false]);
      expect(result.issues).toBeDefined();
      expect(result.issues![0].path).toEqual([1]);
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toEqualTypeOf<boolean[]>();
    });
  });

  describe("default option", () => {
    test("static default", () => {
      const schema = boolean({ default: false });
      const result = schema["~standard"].validate(undefined);
      expect(result.issues).toBeUndefined();
      expect((result as { value: boolean }).value).toBe(false);
    });

    test("default factory function", () => {
      let toggle = false;
      const schema = boolean({ default: () => (toggle = !toggle) });
      expect(
        (schema["~standard"].validate(undefined) as { value: boolean }).value
      ).toBe(true);
      expect(
        (schema["~standard"].validate(undefined) as { value: boolean }).value
      ).toBe(false);
    });
  });

  describe("transform option", () => {
    const schema = boolean({ transform: (b) => !b } as any);

    test("applies transform to output", () => {
      const result = schema["~standard"].validate(true);
      expect(result.issues).toBeUndefined();
      expect((result as { value: boolean }).value).toBe(false);
    });
  });

  describe("combined options", () => {
    test("optional + nullable", () => {
      const schema = boolean({ optional: true, nullable: true });
      expect(schema["~standard"].validate(undefined).issues).toBeUndefined();
      expect(schema["~standard"].validate(null).issues).toBeUndefined();
      expect(schema["~standard"].validate(true).issues).toBeUndefined();
    });

    test("array + optional", () => {
      const schema = boolean({ array: true, optional: true });
      expect(schema["~standard"].validate(undefined).issues).toBeUndefined();
      expect(schema["~standard"].validate([true]).issues).toBeUndefined();
    });
  });
});
