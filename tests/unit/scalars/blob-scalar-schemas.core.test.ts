/**
 * Blob Scalar Schema Type & Runtime Tests
 *
 * Systematically tests type inference AND runtime validation for blob scalar variants:
 * - Raw (required)
 * - Nullable (with default null)
 *
 * Note: Blob scalars do NOT support array modifier (throws at runtime).
 *
 * For each variant, tests:
 * - base: The element/scalar type (Uint8Array | Buffer)
 * - create: Input type for creation + runtime validation
 * - update: Input type for updates + shorthand transforms
 * - filter: Input type for filtering + shorthand transforms (equals, not, in, notIn)
 */

import { blob } from "@schema/scalars/blob/scalar";
import type { ScalarState } from "@schema/scalars/common";
import { type InferInput, parse } from "@validation";
import { type GetScalarSchemas, getScalarSchemas } from "@validation/scalars";
import { describe, expect, expectTypeOf, test } from "vitest";

type InferScalarInput<
  State extends ScalarState,
  Key extends keyof GetScalarSchemas<State>,
> = InferInput<GetScalarSchemas<State>[Key]>;
type InferBlobInput<
  State extends ScalarState<"blob">,
  Key extends keyof GetScalarSchemas<State>,
> = InferScalarInput<State, Key>;

// Test data
const testData1 = new Uint8Array([1, 2, 3, 4]);
const testData2 = new Uint8Array([5, 6, 7, 8]);
const testBuffer = Buffer.from([9, 10, 11, 12]);
const emptyData = new Uint8Array([]);

// =============================================================================
// RAW BLOB SCALAR (required, no modifiers)
// =============================================================================

describe("Raw Blob Scalar", () => {
  const scalar = blob();
  type State = (typeof scalar)["~"]["state"];
  const schemas = getScalarSchemas(scalar["~"].state);

  describe("base", () => {
    test("type: base accepts Uint8Array or Buffer", () => {
      type Base = InferBlobInput<State, "base">;
      expectTypeOf<Uint8Array<ArrayBuffer>>().toExtend<Base>();
      expectTypeOf<Buffer>().toExtend<Base>();
    });

    test("runtime: parses Uint8Array", () => {
      const result = parse(schemas.base, testData1);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBeInstanceOf(Uint8Array);
      expect(result.value).toEqual(testData1);
    });

    test("runtime: parses Buffer", () => {
      const result = parse(schemas.base, testBuffer);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBeInstanceOf(Buffer);
      expect(result.value).toEqual(testBuffer);
    });

    test("runtime: parses empty Uint8Array", () => {
      const result = parse(schemas.base, emptyData);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBeInstanceOf(Uint8Array);
      expect(result.value.length).toBe(0);
    });

    test("runtime: rejects non-binary", () => {
      expect(parse(schemas.base, "hello").issues).toBeDefined();
      expect(parse(schemas.base, 123).issues).toBeDefined();
      expect(parse(schemas.base, null).issues).toBeDefined();
      expect(parse(schemas.base, [1, 2, 3]).issues).toBeDefined();
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
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual(testData1);
    });

    test("runtime: accepts Buffer", () => {
      const result = parse(schemas.create, testBuffer);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual(testBuffer);
    });

    test("runtime: accepts empty Uint8Array", () => {
      const result = parse(schemas.create, emptyData);
      if (result.issues) throw new Error("Expected success");
      expect(result.value.length).toBe(0);
    });

    test("runtime: rejects undefined (required)", () => {
      const result = parse(schemas.create, undefined);
      expect(result.issues).toBeDefined();
    });

    test("runtime: rejects null", () => {
      const result = parse(schemas.create, null);
      expect(result.issues).toBeDefined();
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
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ set: testData1 });
    });

    test("runtime: shorthand Buffer transforms to { set: value }", () => {
      const result = parse(schemas.update, testBuffer);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ set: testBuffer });
    });

    test("runtime: object form passes through", () => {
      const result1 = parse(schemas.update, { set: testData1 });
      if (result1.issues) throw new Error("Expected success");
      expect(result1.value).toEqual({ set: testData1 });

      const result2 = parse(schemas.update, { set: testBuffer });
      if (result2.issues) throw new Error("Expected success");
      expect(result2.value).toEqual({ set: testBuffer });
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
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ equals: testData1 });
    });

    test("runtime: shorthand Buffer transforms to { equals: value }", () => {
      const result = parse(schemas.filter, testBuffer);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ equals: testBuffer });
    });

    test("runtime: object form passes through", () => {
      const result1 = parse(schemas.filter, { equals: testData1 });
      if (result1.issues) throw new Error("Expected success");
      expect(result1.value).toEqual({ equals: testData1 });

      const result2 = parse(schemas.filter, { equals: testBuffer });
      if (result2.issues) throw new Error("Expected success");
      expect(result2.value).toEqual({ equals: testBuffer });
    });

    test("runtime: not filter passes through", () => {
      const result1 = parse(schemas.filter, { not: testData1 });
      if (result1.issues) throw new Error("Expected success");
      expect(result1.value).toEqual({ not: { equals: testData1 } });

      const result2 = parse(schemas.filter, { not: { equals: testBuffer } });
      if (result2.issues) throw new Error("Expected success");
      expect(result2.value).toEqual({ not: { equals: testBuffer } });
    });

    // -------------------------------------------------------------------------
    // Set membership. Prisma's BytesFilter carries in/notIn; viborm used to fall
    // back to the {equals, not} base set, so a byte-array list had no spelling.
    // -------------------------------------------------------------------------

    test("type: filter accepts in/notIn lists", () => {
      type Filter = InferBlobInput<State, "filter">;
      expectTypeOf<{ in: Uint8Array[] }>().toExtend<Filter>();
      expectTypeOf<{ notIn: Uint8Array[] }>().toExtend<Filter>();
      expectTypeOf<{ in: Buffer[] }>().toExtend<Filter>();
    });

    test("runtime: in list passes through", () => {
      const result = parse(schemas.filter, { in: [testData1, testData2] });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ in: [testData1, testData2] });
    });

    test("runtime: notIn list passes through, Buffers included", () => {
      const result = parse(schemas.filter, { notIn: [testBuffer, emptyData] });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ notIn: [testBuffer, emptyData] });
    });

    test("runtime: empty in/notIn lists are accepted", () => {
      // Not a no-op downstream: `in: []` matches nothing and `notIn: []`
      // matches everything, so the schema must let them through rather than
      // treating an empty list as absent.
      const inResult = parse(schemas.filter, { in: [] });
      if (inResult.issues) throw new Error("Expected success");
      expect(inResult.value).toEqual({ in: [] });

      const notInResult = parse(schemas.filter, { notIn: [] });
      if (notInResult.issues) throw new Error("Expected success");
      expect(notInResult.value).toEqual({ notIn: [] });
    });

    test("runtime: in/notIn reject non-blob members", () => {
      expect(parse(schemas.filter, { in: ["not-bytes"] }).issues).toBeDefined();
      expect(parse(schemas.filter, { notIn: [123] }).issues).toBeDefined();
      expect(parse(schemas.filter, { in: [null] }).issues).toBeDefined();
    });

    test("runtime: in/notIn compose under a nested not", () => {
      const result = parse(schemas.filter, {
        not: { not: { in: [testData1] } },
      });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ not: { not: { in: [testData1] } } });
    });
  });
});

// =============================================================================
// NULLABLE BLOB SCALAR
// =============================================================================

describe("Nullable Blob Scalar", () => {
  const scalar = blob().nullable();
  type State = (typeof scalar)["~"]["state"];
  const schemas = getScalarSchemas(scalar["~"].state);

  describe("base", () => {
    test("type: base accepts Uint8Array, Buffer, or null", () => {
      type Base = InferBlobInput<State, "base">;
      expectTypeOf<Uint8Array<ArrayBuffer>>().toExtend<Base>();
      expectTypeOf<Buffer>().toExtend<Base>();
      expectTypeOf<null>().toExtend<Base>();
    });

    test("runtime: parses Uint8Array", () => {
      const result = parse(schemas.base, testData1);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual(testData1);
    });

    test("runtime: parses Buffer", () => {
      const result = parse(schemas.base, testBuffer);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual(testBuffer);
    });

    test("runtime: parses null", () => {
      const result = parse(schemas.base, null);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe(null);
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
      const result = parse(schemas.create, testData1);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual(testData1);
    });

    test("runtime: accepts Buffer", () => {
      const result = parse(schemas.create, testBuffer);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual(testBuffer);
    });

    test("runtime: accepts null", () => {
      const result = parse(schemas.create, null);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe(null);
    });

    test("runtime: undefined defaults to null", () => {
      const result = parse(schemas.create, undefined);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe(null);
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
      const result = parse(schemas.update, testData1);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ set: testData1 });
    });

    test("runtime: shorthand Buffer transforms to { set: value }", () => {
      const result = parse(schemas.update, testBuffer);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ set: testBuffer });
    });

    test("runtime: shorthand null transforms to { set: null }", () => {
      const result = parse(schemas.update, null);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ set: null });
    });

    test("runtime: object form passes through", () => {
      const result1 = parse(schemas.update, { set: testData1 });
      if (result1.issues) throw new Error("Expected success");
      expect(result1.value).toEqual({ set: testData1 });

      const result2 = parse(schemas.update, { set: null });
      if (result2.issues) throw new Error("Expected success");
      expect(result2.value).toEqual({ set: null });
    });
  });

  describe("filter", () => {
    test("type: filter accepts null", () => {
      type Filter = InferBlobInput<State, "filter">;
      expectTypeOf<null>().toExtend<Filter>();
      expectTypeOf<{ equals: null }>().toExtend<Filter>();
    });

    test("runtime: shorthand null transforms to { equals: null }", () => {
      const result = parse(schemas.filter, null);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ equals: null });
    });

    test("runtime: object form with null passes through", () => {
      const result = parse(schemas.filter, { equals: null });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ equals: null });
    });

    test("runtime: not filter with null", () => {
      const result = parse(schemas.filter, { not: null });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ not: { equals: null } });
    });
  });
});

// =============================================================================
// DEFAULT VALUE BEHAVIOR
// =============================================================================

describe("Default Value Behavior", () => {
  describe("static default value", () => {
    const defaultData = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const scalar = blob().default(defaultData);
    type State = (typeof scalar)["~"]["state"];
    const schemas = getScalarSchemas(scalar["~"].state);

    test("type: create is optional", () => {
      type Create = InferBlobInput<State, "create">;
      expectTypeOf<Uint8Array<ArrayBuffer> | undefined>().toExtend<Create>();
      expectTypeOf<Buffer | undefined>().toExtend<Create>();
    });

    test("runtime: accepts value", () => {
      const result = parse(schemas.create, testData2);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual(testData2);
    });

    test("runtime: undefined uses default", () => {
      const result = parse(schemas.create, undefined);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual(defaultData);
    });
  });

  describe("function default value", () => {
    let callCount = 0;
    const scalar = blob().default(() => {
      callCount++;
      return new Uint8Array([callCount]);
    });
    const schemas = getScalarSchemas(scalar["~"].state);

    test("type: create is optional", () => {
      type State = (typeof scalar)["~"]["state"];
      type Create = InferBlobInput<State, "create">;
      expectTypeOf<Uint8Array<ArrayBuffer> | undefined>().toExtend<Create>();
      expectTypeOf<Buffer | undefined>().toExtend<Create>();
    });

    test("runtime: undefined calls default function", () => {
      const before = callCount;
      const result = parse(schemas.create, undefined);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual(new Uint8Array([before + 1]));
    });
  });
});

// =============================================================================
// ARRAY NOT SUPPORTED
// =============================================================================

describe("Array Not Supported", () => {
  test("blob().array() throws error", () => {
    expect(() => blob().array()).toThrow("Blob scalars don't support array");
  });

  test("blob().id() throws error", () => {
    expect(() => blob().id()).toThrow("Blob scalars cannot be used as IDs");
  });

  test("blob().unique() throws error", () => {
    expect(() => blob().unique()).toThrow("Blob scalars cannot be unique");
  });
});
