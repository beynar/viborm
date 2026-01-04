import type { StandardSchemaV1 } from "@standard-schema/spec";
import { instance } from "@validation";
import { describe, expect, expectTypeOf, test } from "vitest";

describe("instance schema", () => {
  describe("basic validation", () => {
    const schema = instance(Uint8Array);

    test("validates instances", () => {
      const arr = new Uint8Array([1, 2, 3]);
      const result = schema["~standard"].validate(arr);
      expect(result.issues).toBeUndefined();
      expect((result as { value: Uint8Array }).value).toEqual(arr);
    });

    test("rejects non-instances", () => {
      expect(schema["~standard"].validate([1, 2, 3]).issues).toBeDefined();
      expect(schema["~standard"].validate("buffer").issues).toBeDefined();
      expect(schema["~standard"].validate(null).issues).toBeDefined();
      expect(schema["~standard"].validate(undefined).issues).toBeDefined();
    });

    test("rejects instances of different class", () => {
      expect(
        schema["~standard"].validate(new Int8Array([1, 2, 3])).issues
      ).toBeDefined();
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toEqualTypeOf<Uint8Array>();
    });
  });

  describe("different classes", () => {
    test("Buffer (Node.js)", () => {
      const schema = instance(Buffer);
      const buf = Buffer.from([1, 2, 3]);
      const result = schema["~standard"].validate(buf);
      expect(result.issues).toBeUndefined();
      expect((result as { value: Buffer }).value).toEqual(buf);
    });

    test("Date", () => {
      const schema = instance(Date);
      const d = new Date();
      const result = schema["~standard"].validate(d);
      expect(result.issues).toBeUndefined();
    });

    test("RegExp", () => {
      const schema = instance(RegExp);
      const regex = /test/;
      const result = schema["~standard"].validate(regex);
      expect(result.issues).toBeUndefined();
    });
  });

  describe("optional option", () => {
    const schema = instance(Uint8Array, { optional: true });

    test("allows undefined", () => {
      const result = schema["~standard"].validate(undefined);
      expect(result.issues).toBeUndefined();
    });

    test("validates instances", () => {
      const result = schema["~standard"].validate(new Uint8Array([1]));
      expect(result.issues).toBeUndefined();
    });
  });

  describe("nullable option", () => {
    const schema = instance(Uint8Array, { nullable: true });

    test("allows null", () => {
      const result = schema["~standard"].validate(null);
      expect(result.issues).toBeUndefined();
    });
  });

  describe("array option", () => {
    const schema = instance(Uint8Array, { array: true });

    test("validates array of instances", () => {
      const arrays = [new Uint8Array([1]), new Uint8Array([2])];
      const result = schema["~standard"].validate(arrays);
      expect(result.issues).toBeUndefined();
      const resultValue = (result as { value: Uint8Array[] }).value;
      expect(resultValue.length).toBe(2);
      expect(resultValue[0]).toEqual(arrays[0]);
      expect(resultValue[1]).toEqual(arrays[1]);
    });

    test("rejects array with non-instances", () => {
      const result = schema["~standard"].validate([
        new Uint8Array([1]),
        [2, 3],
      ]);
      expect(result.issues).toBeDefined();
    });
  });
});
