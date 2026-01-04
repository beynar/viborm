import type { StandardSchemaV1 } from "@standard-schema/spec";
import { bigint } from "@validation";
import { describe, expect, expectTypeOf, test } from "vitest";

describe("bigint schema", () => {
  describe("basic validation", () => {
    const schema = bigint();

    test("validates bigints", () => {
      const result = schema["~standard"].validate(BigInt(42));
      expect(result.issues).toBeUndefined();
      expect((result as { value: bigint }).value).toBe(BigInt(42));
    });

    test("validates zero", () => {
      const result = schema["~standard"].validate(BigInt(0));
      expect(result.issues).toBeUndefined();
      expect((result as { value: bigint }).value).toBe(BigInt(0));
    });

    test("validates negative bigints", () => {
      const result = schema["~standard"].validate(BigInt(-42));
      expect(result.issues).toBeUndefined();
      expect((result as { value: bigint }).value).toBe(BigInt(-42));
    });

    test("validates very large bigints", () => {
      const large = BigInt("9007199254740992");
      const result = schema["~standard"].validate(large);
      expect(result.issues).toBeUndefined();
      expect((result as { value: bigint }).value).toBe(large);
    });

    test("rejects numbers", () => {
      const result = schema["~standard"].validate(42);
      expect(result.issues).toBeDefined();
    });

    test("rejects strings", () => {
      const result = schema["~standard"].validate("42");
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
      expectTypeOf<Output>().toEqualTypeOf<bigint>();
      expectTypeOf<Input>().toEqualTypeOf<bigint>();
    });
  });

  describe("optional option", () => {
    const schema = bigint({ optional: true });

    test("allows undefined", () => {
      const result = schema["~standard"].validate(undefined);
      expect(result.issues).toBeUndefined();
      expect((result as { value: bigint | undefined }).value).toBeUndefined();
    });

    test("validates bigints", () => {
      const result = schema["~standard"].validate(BigInt(42));
      expect(result.issues).toBeUndefined();
      expect((result as { value: bigint | undefined }).value).toBe(BigInt(42));
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toEqualTypeOf<bigint | undefined>();
    });
  });

  describe("nullable option", () => {
    const schema = bigint({ nullable: true });

    test("allows null", () => {
      const result = schema["~standard"].validate(null);
      expect(result.issues).toBeUndefined();
      expect((result as { value: bigint | null }).value).toBeNull();
    });

    test("validates bigints", () => {
      const result = schema["~standard"].validate(BigInt(42));
      expect(result.issues).toBeUndefined();
      expect((result as { value: bigint | null }).value).toBe(BigInt(42));
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toEqualTypeOf<bigint | null>();
    });
  });

  describe("array option", () => {
    const schema = bigint({ array: true });

    test("validates array of bigints", () => {
      const result = schema["~standard"].validate([
        BigInt(1),
        BigInt(2),
        BigInt(3),
      ]);
      expect(result.issues).toBeUndefined();
      expect((result as { value: bigint[] }).value).toEqual([
        BigInt(1),
        BigInt(2),
        BigInt(3),
      ]);
    });

    test("rejects array with numbers", () => {
      const result = schema["~standard"].validate([BigInt(1), 2, BigInt(3)]);
      expect(result.issues).toBeDefined();
      expect(result.issues![0].path).toEqual([1]);
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toEqualTypeOf<bigint[]>();
    });
  });

  describe("default option", () => {
    test("static default", () => {
      const schema = bigint({ default: BigInt(0) });
      const result = schema["~standard"].validate(undefined);
      expect(result.issues).toBeUndefined();
      expect((result as { value: bigint }).value).toBe(BigInt(0));
    });

    test("default not applied when value provided", () => {
      const schema = bigint({ default: BigInt(0) });
      const result = schema["~standard"].validate(BigInt(42));
      expect((result as { value: bigint }).value).toBe(BigInt(42));
    });
  });

  describe("transform option", () => {
    const schema = bigint({ transform: (n) => n * BigInt(2) } as any);

    test("applies transform to output", () => {
      const result = schema["~standard"].validate(BigInt(21));
      expect(result.issues).toBeUndefined();
      expect((result as { value: bigint }).value).toBe(BigInt(42));
    });
  });
});
