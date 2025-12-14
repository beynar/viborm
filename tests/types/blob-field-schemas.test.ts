/**
 * Blob Field Schema Type & Runtime Tests
 *
 * Systematically tests type inference AND runtime validation for blob field variants:
 * - Raw (required)
 * - Nullable (with default null)
 *
 * Note: Blob fields do NOT support array modifier (throws at runtime).
 *
 * For each variant, tests:
 * - base: The element/field type (Uint8Array | Buffer)
 * - create: Input type for creation + runtime validation
 * - update: Input type for updates + shorthand transforms
 * - filter: Input type for filtering + shorthand transforms (equals and not only)
 */

import { describe, test, expect, expectTypeOf } from "vitest";
import { parse } from "valibot";
import { blob } from "../../src/schema/fields/blob/field";
import type { InferBlobInput } from "../../src/schema/fields/blob/schemas";

// Test data
const testData1 = new Uint8Array([1, 2, 3, 4]);
const testData2 = new Uint8Array([5, 6, 7, 8]);
const testBuffer = Buffer.from([9, 10, 11, 12]);
const emptyData = new Uint8Array([]);

// =============================================================================
// RAW BLOB FIELD (required, no modifiers)
// =============================================================================

describe("Raw Blob Field", () => {
  const field = blob();
  type State = (typeof field)["~"]["state"];
  const schemas = field["~"].schemas;

  describe("base", () => {
    test("type: base accepts Uint8Array or Buffer", () => {
      type Base = InferBlobInput<State, "base">;
      expectTypeOf<Uint8Array<ArrayBuffer>>().toExtend<Base>();
      expectTypeOf<Buffer>().toExtend<Base>();
    });

    test("runtime: parses Uint8Array", () => {
      const result = parse(schemas.base, testData1);
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result).toEqual(testData1);
    });

    test("runtime: parses Buffer", () => {
      const result = parse(schemas.base, testBuffer);
      expect(result).toBeInstanceOf(Buffer);
      expect(result).toEqual(testBuffer);
    });

    test("runtime: parses empty Uint8Array", () => {
      const result = parse(schemas.base, emptyData);
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.length).toBe(0);
    });

    test("runtime: rejects non-binary", () => {
      expect(() => parse(schemas.base, "hello")).toThrow();
      expect(() => parse(schemas.base, 123)).toThrow();
      expect(() => parse(schemas.base, null)).toThrow();
      expect(() => parse(schemas.base, [1, 2, 3])).toThrow();
    });
  });

  describe("create", () => {
    test("type: create accepts Uint8Array or Buffer (required)", () => {
      type Create = InferBlobInput<State, "create">;
      expectTypeOf<Uint8Array<ArrayBuffer>>().toExtend<Create>();
      expectTypeOf<Buffer>().toExtend<Create>();
    });

    test("runtime: accepts Uint8Array", () => {
      const result = parse(schemas.create, testData1);
      expect(result).toEqual(testData1);
    });

    test("runtime: accepts Buffer", () => {
      const result = parse(schemas.create, testBuffer);
      expect(result).toEqual(testBuffer);
    });

    test("runtime: accepts empty Uint8Array", () => {
      const result = parse(schemas.create, emptyData);
      expect(result.length).toBe(0);
    });

    test("runtime: rejects undefined (required)", () => {
      expect(() => parse(schemas.create, undefined)).toThrow();
    });

    test("runtime: rejects null", () => {
      expect(() => parse(schemas.create, null)).toThrow();
    });
  });

  describe("update", () => {
    test("type: update accepts Uint8Array, Buffer, or { set: ... }", () => {
      type Update = InferBlobInput<State, "update">;
      expectTypeOf<Uint8Array<ArrayBuffer>>().toExtend<Update>();
      expectTypeOf<Buffer>().toExtend<Update>();
      expectTypeOf<{ set: Uint8Array<ArrayBuffer> }>().toExtend<Update>();
      expectTypeOf<{ set: Buffer }>().toExtend<Update>();
    });

    test("runtime: shorthand Uint8Array transforms to { set: value }", () => {
      const result = parse(schemas.update, testData1);
      expect(result).toEqual({ set: testData1 });
    });

    test("runtime: shorthand Buffer transforms to { set: value }", () => {
      const result = parse(schemas.update, testBuffer);
      expect(result).toEqual({ set: testBuffer });
    });

    test("runtime: object form passes through", () => {
      expect(parse(schemas.update, { set: testData1 })).toEqual({
        set: testData1,
      });
      expect(parse(schemas.update, { set: testBuffer })).toEqual({
        set: testBuffer,
      });
    });
  });

  describe("filter", () => {
    test("type: filter accepts shorthand", () => {
      type Filter = InferBlobInput<State, "filter">;
      expectTypeOf<Uint8Array>().toExtend<Filter>();
      expectTypeOf<Buffer>().toExtend<Filter>();
    });

    test("type: filter accepts equals object", () => {
      type Filter = InferBlobInput<State, "filter">;
      expectTypeOf<{ equals: Uint8Array }>().toExtend<Filter>();
      expectTypeOf<{ equals: Buffer }>().toExtend<Filter>();
    });

    test("runtime: shorthand Uint8Array transforms to { equals: value }", () => {
      const result = parse(schemas.filter, testData1);
      expect(result).toEqual({ equals: testData1 });
    });

    test("runtime: shorthand Buffer transforms to { equals: value }", () => {
      const result = parse(schemas.filter, testBuffer);
      expect(result).toEqual({ equals: testBuffer });
    });

    test("runtime: object form passes through", () => {
      expect(parse(schemas.filter, { equals: testData1 })).toEqual({
        equals: testData1,
      });
      expect(parse(schemas.filter, { equals: testBuffer })).toEqual({
        equals: testBuffer,
      });
    });

    test("runtime: not filter passes through", () => {
      expect(parse(schemas.filter, { not: testData1 })).toEqual({
        not: { equals: testData1 },
      });
      expect(parse(schemas.filter, { not: { equals: testBuffer } })).toEqual({
        not: { equals: testBuffer },
      });
    });
  });
});

// =============================================================================
// NULLABLE BLOB FIELD
// =============================================================================

describe("Nullable Blob Field", () => {
  const field = blob().nullable();
  type State = (typeof field)["~"]["state"];
  const schemas = field["~"].schemas;

  describe("base", () => {
    test("type: base accepts Uint8Array, Buffer, or null", () => {
      type Base = InferBlobInput<State, "base">;
      expectTypeOf<Uint8Array<ArrayBuffer>>().toExtend<Base>();
      expectTypeOf<Buffer>().toExtend<Base>();
      expectTypeOf<null>().toExtend<Base>();
    });

    test("runtime: parses Uint8Array", () => {
      const result = parse(schemas.base, testData1);
      expect(result).toEqual(testData1);
    });

    test("runtime: parses Buffer", () => {
      const result = parse(schemas.base, testBuffer);
      expect(result).toEqual(testBuffer);
    });

    test("runtime: parses null", () => {
      expect(parse(schemas.base, null)).toBe(null);
    });
  });

  describe("create", () => {
    test("type: create is optional (has default null)", () => {
      type Create = InferBlobInput<State, "create">;
      expectTypeOf<
        Uint8Array<ArrayBuffer> | null | undefined
      >().toExtend<Create>();
      expectTypeOf<Buffer>().toExtend<Create>();
    });

    test("runtime: accepts Uint8Array", () => {
      expect(parse(schemas.create, testData1)).toEqual(testData1);
    });

    test("runtime: accepts Buffer", () => {
      expect(parse(schemas.create, testBuffer)).toEqual(testBuffer);
    });

    test("runtime: accepts null", () => {
      expect(parse(schemas.create, null)).toBe(null);
    });

    test("runtime: undefined defaults to null", () => {
      expect(parse(schemas.create, undefined)).toBe(null);
    });
  });

  describe("update", () => {
    test("type: update accepts Uint8Array, Buffer, null, or { set: ... }", () => {
      type Update = InferBlobInput<State, "update">;
      expectTypeOf<Uint8Array<ArrayBuffer>>().toExtend<Update>();
      expectTypeOf<Buffer>().toExtend<Update>();
      expectTypeOf<null>().toExtend<Update>();
      expectTypeOf<{
        set: Uint8Array<ArrayBuffer> | null;
      }>().toExtend<Update>();
      expectTypeOf<{ set: Buffer }>().toExtend<Update>();
    });

    test("runtime: shorthand Uint8Array transforms to { set: value }", () => {
      expect(parse(schemas.update, testData1)).toEqual({ set: testData1 });
    });

    test("runtime: shorthand Buffer transforms to { set: value }", () => {
      expect(parse(schemas.update, testBuffer)).toEqual({ set: testBuffer });
    });

    test("runtime: shorthand null transforms to { set: null }", () => {
      expect(parse(schemas.update, null)).toEqual({ set: null });
    });

    test("runtime: object form passes through", () => {
      expect(parse(schemas.update, { set: testData1 })).toEqual({
        set: testData1,
      });
      expect(parse(schemas.update, { set: null })).toEqual({ set: null });
    });
  });

  describe("filter", () => {
    test("type: filter accepts null", () => {
      type Filter = InferBlobInput<State, "filter">;
      expectTypeOf<null>().toExtend<Filter>();
      expectTypeOf<{ equals: null }>().toExtend<Filter>();
    });

    test("runtime: shorthand null transforms to { equals: null }", () => {
      expect(parse(schemas.filter, null)).toEqual({ equals: null });
    });

    test("runtime: object form with null passes through", () => {
      expect(parse(schemas.filter, { equals: null })).toEqual({ equals: null });
    });

    test("runtime: not filter with null", () => {
      expect(parse(schemas.filter, { not: null })).toEqual({
        not: { equals: null },
      });
    });
  });
});

// =============================================================================
// DEFAULT VALUE BEHAVIOR
// =============================================================================

describe("Default Value Behavior", () => {
  describe("static default value", () => {
    const defaultData = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const field = blob().default(defaultData);
    type State = (typeof field)["~"]["state"];
    const schemas = field["~"].schemas;

    test("type: create is optional", () => {
      type Create = InferBlobInput<State, "create">;
      expectTypeOf<Uint8Array<ArrayBuffer> | undefined>().toExtend<Create>();
      expectTypeOf<Buffer | undefined>().toExtend<Create>();
    });

    test("runtime: accepts value", () => {
      expect(parse(schemas.create, testData2)).toEqual(testData2);
    });

    test("runtime: undefined uses default", () => {
      expect(parse(schemas.create, undefined)).toEqual(defaultData);
    });
  });

  describe("function default value", () => {
    let callCount = 0;
    const field = blob().default(() => {
      callCount++;
      return new Uint8Array([callCount]);
    });
    const schemas = field["~"].schemas;

    test("type: create is optional", () => {
      type State = (typeof field)["~"]["state"];
      type Create = InferBlobInput<State, "create">;
      expectTypeOf<Uint8Array<ArrayBuffer> | undefined>().toExtend<Create>();
      expectTypeOf<Buffer | undefined>().toExtend<Create>();
    });

    test("runtime: undefined calls default function", () => {
      const before = callCount;
      const result = parse(schemas.create, undefined);
      expect(result).toEqual(new Uint8Array([before + 1]));
    });
  });
});

// =============================================================================
// ARRAY NOT SUPPORTED
// =============================================================================

describe("Array Not Supported", () => {
  test("blob().array() throws error", () => {
    expect(() => blob().array()).toThrow("Blob fields don't support array");
  });

  test("blob().id() throws error", () => {
    expect(() => blob().id()).toThrow("Blob fields cannot be used as IDs");
  });

  test("blob().unique() throws error", () => {
    expect(() => blob().unique()).toThrow("Blob fields cannot be unique");
  });
});
