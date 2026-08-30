import vm from "node:vm";
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

    test("keeps a local Uint8Array by identity", () => {
      const arr = new Uint8Array([1, 2, 3]);
      expect((parse(schema, arr) as { value: Uint8Array }).value).toBe(arr);
    });

    test("accepts a Uint8Array from another realm as a local view", () => {
      const foreign: Uint8Array = vm.runInNewContext("new Uint8Array([1,2,3])");
      expect(foreign instanceof Uint8Array).toBe(false);

      const result = parse(schema, foreign);
      expect(result.issues).toBeUndefined();
      const { value } = result as { value: Uint8Array };
      expect(value instanceof Uint8Array).toBe(true);
      expect(Array.from(value)).toEqual([1, 2, 3]);
      // The same memory, not a copy — the view only restores local identity.
      value[0] = 9;
      expect(foreign[0]).toBe(9);
    });

    test("rejects a foreign view over a detached buffer as an issue", () => {
      // Detaching the backing buffer makes the local re-view unconstructible;
      // the refusal must stay an issue, not a thrown TypeError escaping the
      // Standard Schema surface.
      const foreign: Uint8Array = vm.runInNewContext(
        "const u8 = new Uint8Array([1, 2, 3]); u8.buffer.transfer(); u8"
      );
      expect(parse(schema, foreign).issues).toBeDefined();
    });

    test("rejects values that merely spell the Uint8Array tag", () => {
      expect(
        parse(schema, { [Symbol.toStringTag]: "Uint8Array", length: 3 }).issues
      ).toBeDefined();
      expect(parse(schema, new Float64Array(3)).issues).toBeDefined();
      expect(
        parse(schema, new DataView(new ArrayBuffer(3))).issues
      ).toBeDefined();
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
