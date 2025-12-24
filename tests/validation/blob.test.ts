import { describe, test, expect, expectTypeOf } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { v, blob } from "../../src/validation";

describe("blob schema", () => {
  describe("basic validation", () => {
    const schema = blob();

    test("validates Uint8Array", () => {
      const arr = new Uint8Array([1, 2, 3]);
      const result = schema["~standard"].validate(arr);
      expect(result.issues).toBeUndefined();
      expect((result as { value: Uint8Array | Buffer }).value).toEqual(arr);
    });

    test("validates Buffer", () => {
      const buf = Buffer.from([1, 2, 3]);
      const result = schema["~standard"].validate(buf);
      expect(result.issues).toBeUndefined();
      expect((result as { value: Uint8Array | Buffer }).value).toEqual(buf);
    });

    test("rejects other types", () => {
      expect(schema["~standard"].validate([1, 2, 3]).issues).toBeDefined();
      expect(schema["~standard"].validate("buffer").issues).toBeDefined();
      expect(schema["~standard"].validate(null).issues).toBeDefined();
      expect(schema["~standard"].validate(undefined).issues).toBeDefined();
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toEqualTypeOf<Uint8Array | Buffer>();
    });
  });

  describe("optional option", () => {
    const schema = blob({ optional: true });

    test("allows undefined", () => {
      const result = schema["~standard"].validate(undefined);
      expect(result.issues).toBeUndefined();
    });
  });

  describe("nullable option", () => {
    const schema = blob({ nullable: true });

    test("allows null", () => {
      const result = schema["~standard"].validate(null);
      expect(result.issues).toBeUndefined();
    });
  });

  describe("array option", () => {
    const schema = blob({ array: true });

    test("validates array of blobs", () => {
      const blobs = [new Uint8Array([1]), Buffer.from([2])];
      const result = schema["~standard"].validate(blobs);
      expect(result.issues).toBeUndefined();
      expect((result as { value: (Uint8Array | Buffer)[] }).value).toEqual(blobs);
    });
  });
});

