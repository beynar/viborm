import vm from "node:vm";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import v, { parse } from "@validation";
import { describe, expect, expectTypeOf, test, vi } from "vitest";

function successfulValue<const S extends StandardSchemaV1>(
  schema: S,
  input: unknown
): StandardSchemaV1.InferOutput<S> {
  const result = parse(schema, input);
  if (result.issues) throw new Error("Expected success");
  return result.value;
}

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
      expect(successfulValue(schema, buf)).toBe(buf);
    });

    test("rejects other types", () => {
      expect(parse(schema, [1, 2, 3]).issues).toBeDefined();
      expect(parse(schema, "buffer").issues).toBeDefined();
      expect(parse(schema, null).issues).toBeDefined();
      expect(parse(schema, undefined).issues).toBeDefined();
    });

    test("keeps a local Uint8Array by identity", () => {
      const arr = new Uint8Array([1, 2, 3]);
      expect(successfulValue(schema, arr)).toBe(arr);
    });

    test("accepts a Uint8Array from another realm as a local view", () => {
      const foreign: Uint8Array = vm.runInNewContext("new Uint8Array([1,2,3])");
      expect(foreign instanceof Uint8Array).toBe(false);

      const value = successfulValue(schema, foreign);
      expect(value instanceof Uint8Array).toBe(true);
      expect(Array.from(value)).toEqual([1, 2, 3]);
      // The same memory, not a copy — the view only restores local identity.
      value[0] = 9;
      expect(foreign[0]).toBe(9);
    });

    test("reads a foreign view through intrinsic metadata accessors", () => {
      const foreign: Uint8Array = vm.runInNewContext(`
        const view = new Uint8Array([0, 1, 2, 3]).subarray(1, 3);
        Object.defineProperties(view, {
          buffer: { value: new ArrayBuffer(0) },
          byteOffset: { value: 0 },
          byteLength: { value: 0 },
        });
        view;
      `);
      expect(foreign instanceof Uint8Array).toBe(false);

      const value = successfulValue(schema, foreign);
      expect(Array.from(value)).toEqual([1, 2]);
      value[0] = 9;
      expect(foreign[0]).toBe(9);
    });

    test.each([
      "buffer",
      "byteOffset",
      "byteLength",
    ])("normalizes a local view with an own %s shadow", (property) => {
      const backing = new Uint8Array([0, 1, 2, 3]);
      const view = backing.subarray(1, 3);
      const shadow = property === "buffer" ? new ArrayBuffer(0) : 0;
      Object.defineProperty(view, property, { value: shadow });

      const value = successfulValue(schema, view);
      expect(value).not.toBe(view);
      expect(Array.from(value)).toEqual([1, 2]);
      expect(Object.hasOwn(value, property)).toBe(false);
      value[0] = 9;
      expect(view[0]).toBe(9);
    });

    test.each([
      "buffer",
      "byteOffset",
      "byteLength",
    ])("normalizes a local subclass with an inherited %s shadow", (property) => {
      class ShadowedBytes extends Uint8Array {}
      const shadow = property === "buffer" ? new ArrayBuffer(0) : 0;
      Object.defineProperty(ShadowedBytes.prototype, property, {
        get: () => shadow,
      });
      const view = new ShadowedBytes([1, 2, 3]);

      const result = parse(schema, view);
      if (result.issues) throw new Error("Expected success");
      const { value } = result;
      expect(value).not.toBe(view);
      expect(Object.getPrototypeOf(value)).toBe(Uint8Array.prototype);
      expect(Array.from(value)).toEqual([1, 2, 3]);
    });

    test("normalizes a local Uint8Array subclass", () => {
      class CustomBytes extends Uint8Array {}
      const view = new CustomBytes([1, 2, 3]);

      const result = parse(schema, view);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).not.toBe(view);
      expect(Object.getPrototypeOf(result.value)).toBe(Uint8Array.prototype);
      expect(Array.from(result.value)).toEqual([1, 2, 3]);
    });

    test("normalizes metadata hidden behind an intermediate Proxy prototype", () => {
      const view = new Uint8Array([1, 2, 3]);
      const prototype = new Proxy(Object.create(null), {
        get: (_target, property, receiver) =>
          property === "byteLength"
            ? 0
            : Reflect.get(Uint8Array.prototype, property, receiver),
        getPrototypeOf: () => Uint8Array.prototype,
      });
      Object.setPrototypeOf(view, prototype);

      const result = parse(schema, view);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).not.toBe(view);
      expect(Object.getPrototypeOf(result.value)).toBe(Uint8Array.prototype);
      expect(Array.from(result.value)).toEqual([1, 2, 3]);
    });

    test("contains a cyclic prototype Proxy and normalizes the view", () => {
      const view = new Uint8Array([1, 2, 3]);
      let prototype: object;
      prototype = new Proxy(Object.create(null), {
        getPrototypeOf: () => prototype,
      });
      Object.setPrototypeOf(view, prototype);

      const result = parse(schema, view);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).not.toBe(view);
      expect(Array.from(result.value)).toEqual([1, 2, 3]);
    });

    test("does not traverse a prototype trap that could detach the buffer", () => {
      const buffer = new ArrayBuffer(3);
      const view = new Uint8Array(buffer);
      let trapCalls = 0;
      const prototype = new Proxy(Uint8Array.prototype, {
        getPrototypeOf: () => {
          trapCalls++;
          structuredClone(buffer, { transfer: [buffer] });
          return Uint8Array.prototype;
        },
      });
      Object.setPrototypeOf(view, prototype);

      const result = parse(schema, view);
      if (result.issues) throw new Error("Expected success");
      expect(trapCalls).toBe(0);
      expect(result.value).not.toBe(view);
      expect(Array.from(result.value)).toEqual([0, 0, 0]);
    });

    test("normalizes a stateful prototype that agrees before lying", () => {
      const view = new Uint8Array([1, 2, 3]);
      let shouldLie = false;
      const prototype = new Proxy(Object.create(null), {
        get: (_target, property, receiver) => {
          if (shouldLie) {
            if (property === "buffer") return new ArrayBuffer(0);
            if (property === "byteOffset" || property === "byteLength") {
              return 0;
            }
          }
          return Reflect.get(Uint8Array.prototype, property, receiver);
        },
        getPrototypeOf: () => Uint8Array.prototype,
      });
      Object.setPrototypeOf(view, prototype);

      const result = parse(schema, view);
      if (result.issues) throw new Error("Expected success");
      shouldLie = true;

      expect(Reflect.get(view, "byteLength")).toBe(0);
      expect(result.value).not.toBe(view);
      expect(Object.getPrototypeOf(result.value)).toBe(Uint8Array.prototype);
      expect(Array.from(result.value)).toEqual([1, 2, 3]);
    });

    test("rejects a Proxy over a local Uint8Array", () => {
      const proxy = new Proxy(new Uint8Array([1, 2, 3]), {});
      expect(proxy instanceof Uint8Array).toBe(true);
      expect(parse(schema, proxy).issues).toBeDefined();
    });

    test("rejects a local view over a detached buffer as an issue", () => {
      const buffer = new ArrayBuffer(3);
      const view = new Uint8Array(buffer);
      structuredClone(buffer, { transfer: [buffer] });
      expect(parse(schema, view).issues).toBeDefined();
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

    test("loads without Buffer and keeps the Uint8Array path available", async () => {
      const reflectGet = Reflect.get;
      vi.resetModules();
      const getter = vi
        .spyOn(Reflect, "get")
        .mockImplementation(
          (target: object, propertyKey: PropertyKey, receiver?: unknown) =>
            target === globalThis && propertyKey === "Buffer"
              ? undefined
              : reflectGet(target, propertyKey, receiver)
        );
      try {
        const { validateBlob } = await import("@validation/primitives/blob");
        const bytes = new Uint8Array([1, 2, 3]);
        expect(validateBlob(bytes)).toEqual({ value: bytes });
      } finally {
        getter.mockRestore();
        vi.resetModules();
      }
    });

    test("contains a failing Buffer global during module admission", async () => {
      const reflectGet = Reflect.get;
      vi.resetModules();
      const getter = vi
        .spyOn(Reflect, "get")
        .mockImplementation(
          (target: object, propertyKey: PropertyKey, receiver?: unknown) => {
            if (target === globalThis && propertyKey === "Buffer") {
              throw new Error("Buffer lookup failed");
            }
            return reflectGet(target, propertyKey, receiver);
          }
        );
      try {
        const { validateBlob } = await import("@validation/primitives/blob");
        const bytes = new Uint8Array([1, 2, 3]);
        expect(validateBlob(bytes)).toEqual({ value: bytes });
      } finally {
        getter.mockRestore();
        vi.resetModules();
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
      const value = successfulValue(schema, blobs);
      expect(value.map((entry) => Array.from(entry))).toEqual([[1], [2]]);
      expect(value[0]).toBe(blobs[0]);
      expect(value[1]).toBe(blobs[1]);
    });
  });
});
