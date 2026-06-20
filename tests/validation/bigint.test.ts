import type { StandardSchemaV1 } from "@standard-schema/spec";
import v, { parse } from "@validation";
import { describe, expect, expectTypeOf, test } from "vitest";

describe("bigint schema", () => {
  describe("basic validation", () => {
    const schema = v.bigint();

    test("validates bigints", () => {
      const result = parse(schema, BigInt(42));
      expect(result.issues).toBeUndefined();
      expect((result as { value: bigint }).value).toBe(BigInt(42));
    });

    test("validates zero", () => {
      const result = parse(schema, BigInt(0));
      expect(result.issues).toBeUndefined();
      expect((result as { value: bigint }).value).toBe(BigInt(0));
    });

    test("validates negative bigints", () => {
      const result = parse(schema, BigInt(-42));
      expect(result.issues).toBeUndefined();
      expect((result as { value: bigint }).value).toBe(BigInt(-42));
    });

    test("validates very large bigints", () => {
      const large = BigInt("9007199254740992");
      const result = parse(schema, large);
      expect(result.issues).toBeUndefined();
      expect((result as { value: bigint }).value).toBe(large);
    });

    test("rejects numbers", () => {
      const result = parse(schema, 42);
      expect(result.issues).toBeDefined();
    });

    test("rejects strings", () => {
      const result = parse(schema, "42");
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
      expectTypeOf<Output>().toMatchTypeOf<bigint>();
      expectTypeOf<Input>().toMatchTypeOf<bigint>();
    });
  });

  describe("optional option", () => {
    const schema = v.bigint({ optional: true });

    test("allows undefined", () => {
      const result = parse(schema, undefined);
      expect(result.issues).toBeUndefined();
      expect((result as { value: bigint | undefined }).value).toBeUndefined();
    });

    test("validates bigints", () => {
      const result = parse(schema, BigInt(42));
      expect(result.issues).toBeUndefined();
      expect((result as { value: bigint | undefined }).value).toBe(BigInt(42));
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toMatchTypeOf<bigint | undefined>();
    });
  });

  describe("nullable option", () => {
    const schema = v.bigint({ nullable: true });

    test("allows null", () => {
      const result = parse(schema, null);
      expect(result.issues).toBeUndefined();
      expect((result as { value: bigint | null }).value).toBeNull();
    });

    test("validates bigints", () => {
      const result = parse(schema, BigInt(42));
      expect(result.issues).toBeUndefined();
      expect((result as { value: bigint | null }).value).toBe(BigInt(42));
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toMatchTypeOf<bigint | null>();
    });
  });

  describe("array option", () => {
    const schema = v.bigint({ array: true });

    test("validates array of bigints", () => {
      const result = parse(schema, [
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
      const result = parse(schema, [BigInt(1), 2, BigInt(3)]);
      expect(result.issues).toBeDefined();
      expect(result.issues?.[0]?.path).toEqual([1]);
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toMatchTypeOf<bigint[]>();
    });
  });

  describe("default option", () => {
    test("static default", () => {
      const schema = v.bigint({ default: BigInt(0) });
      const result = parse(schema, undefined);
      expect(result.issues).toBeUndefined();
      expect((result as { value: bigint }).value).toBe(BigInt(0));
    });

    test("default not applied when value provided", () => {
      const schema = v.bigint({ default: BigInt(0) });
      const result = parse(schema, BigInt(42));
      expect((result as { value: bigint }).value).toBe(BigInt(42));
    });
  });

  describe("transform option", () => {
    const schema = v.bigint({ transform: (n) => n * BigInt(2) } as any);

    test("applies transform to output", () => {
      const result = parse(schema, BigInt(21));
      expect(result.issues).toBeUndefined();
      expect((result as { value: bigint }).value).toBe(BigInt(42));
    });
  });
});
