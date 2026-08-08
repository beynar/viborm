import type { StandardSchemaV1 } from "@standard-schema/spec";
import v, { parse } from "@validation";
import { describe, expect, expectTypeOf, test, vi } from "vitest";

describe("blob schema", () => {
  describe("basic validation", () => {
    const schema = v.blob();

    test("validates Uint8Array", () => {
      const arr = new Uint8Array([1, 2, 3]);
      const result = parse(schema, arr);
      expect(result.issues).toBeUndefined();
      expect((result as { value: Uint8Array | Buffer }).value).toEqual(arr);
    });

    test("validates Buffer", () => {
      const buf = Buffer.from([1, 2, 3]);
      const result = parse(schema, buf);
      expect(result.issues).toBeUndefined();
      expect((result as { value: Uint8Array | Buffer }).value).toEqual(buf);
    });

    test("rejects other types", () => {
      expect(parse(schema, [1, 2, 3]).issues).toBeDefined();
      expect(parse(schema, "buffer").issues).toBeDefined();
      expect(parse(schema, null).issues).toBeDefined();
      expect(parse(schema, undefined).issues).toBeDefined();
    });

    test("rejects invalid values without reading a Buffer global", () => {
      vi.stubGlobal("Buffer", undefined);
      try {
        expect(parse(schema, "not-binary").issues).toBeDefined();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toMatchTypeOf<Uint8Array | Buffer>();
    });
  });

  describe("optional option", () => {
    const schema = v.blob({ optional: true });

    test("allows undefined", () => {
      const result = parse(schema, undefined);
      expect(result.issues).toBeUndefined();
    });
  });

  describe("nullable option", () => {
    const schema = v.blob({ nullable: true });

    test("allows null", () => {
      const result = parse(schema, null);
      expect(result.issues).toBeUndefined();
    });
  });

  describe("array option", () => {
    const schema = v.blob({ array: true });

    test("validates array of blobs", () => {
      const blobs = [new Uint8Array([1]), Buffer.from([2])];
      const result = parse(schema, blobs);
      expect(result.issues).toBeUndefined();
      expect((result as { value: (Uint8Array | Buffer)[] }).value).toEqual(
        blobs
      );
    });
  });
});
