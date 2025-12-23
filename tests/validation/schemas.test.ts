import { describe, test, expect, expectTypeOf } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  v,
  string,
  number,
  integer,
  boolean,
  bigint,
  literal,
  date,
  isoTimestamp,
  isoDate,
  isoTime,
  instance,
  array,
  nullable,
  optional,
  object,
  union,
  pipe,
  transform,
  record,
  type VibSchema,
  type InferOutput,
  type InferInput,
} from "../../src/validation";

// =============================================================================
// Scalar Schema Tests
// =============================================================================

describe("string schema", () => {
  const schema = string();

  test("validates strings", () => {
    const result = schema["~standard"].validate("hello");
    expect(result.issues).toBeUndefined();
    expect(result.value).toBe("hello");
  });

  test("rejects non-strings", () => {
    const result = schema["~standard"].validate(123);
    expect(result.issues).toBeDefined();
    expect(result.issues![0].message).toContain("Expected string");
  });

  test("type inference", () => {
    type Output = StandardSchemaV1.InferOutput<typeof schema>;
    type Input = StandardSchemaV1.InferInput<typeof schema>;
    expectTypeOf<Output>().toEqualTypeOf<string>();
    expectTypeOf<Input>().toEqualTypeOf<string>();
  });
});

describe("number schema", () => {
  const schema = number();

  test("validates numbers", () => {
    const result = schema["~standard"].validate(42);
    expect(result.issues).toBeUndefined();
    expect(result.value).toBe(42);
  });

  test("rejects NaN", () => {
    const result = schema["~standard"].validate(NaN);
    expect(result.issues).toBeDefined();
  });

  test("rejects strings", () => {
    const result = schema["~standard"].validate("42");
    expect(result.issues).toBeDefined();
  });
});

describe("integer schema", () => {
  const schema = integer();

  test("validates integers", () => {
    const result = schema["~standard"].validate(42);
    expect(result.issues).toBeUndefined();
    expect(result.value).toBe(42);
  });

  test("rejects floats", () => {
    const result = schema["~standard"].validate(3.14);
    expect(result.issues).toBeDefined();
  });
});

describe("boolean schema", () => {
  const schema = boolean();

  test("validates booleans", () => {
    expect(schema["~standard"].validate(true).value).toBe(true);
    expect(schema["~standard"].validate(false).value).toBe(false);
  });

  test("rejects non-booleans", () => {
    expect(schema["~standard"].validate(1).issues).toBeDefined();
    expect(schema["~standard"].validate("true").issues).toBeDefined();
  });
});

describe("bigint schema", () => {
  const schema = bigint();

  test("validates bigints", () => {
    const result = schema["~standard"].validate(BigInt(42));
    expect(result.issues).toBeUndefined();
    expect(result.value).toBe(BigInt(42));
  });

  test("rejects numbers", () => {
    expect(schema["~standard"].validate(42).issues).toBeDefined();
  });
});

describe("literal schema", () => {
  const schema = literal("admin");

  test("validates exact match", () => {
    const result = schema["~standard"].validate("admin");
    expect(result.issues).toBeUndefined();
    expect(result.value).toBe("admin");
  });

  test("rejects non-match", () => {
    expect(schema["~standard"].validate("user").issues).toBeDefined();
  });

  test("type inference", () => {
    type Output = StandardSchemaV1.InferOutput<typeof schema>;
    expectTypeOf<Output>().toEqualTypeOf<"admin">();
  });
});

// =============================================================================
// Scalar Options Tests
// =============================================================================

describe("scalar options", () => {
  test("optional allows undefined", () => {
    const schema = string({ optional: true });
    const result = schema["~standard"].validate(undefined);
    expect(result.issues).toBeUndefined();
    expect(result.value).toBe(undefined);
  });

  test("nullable allows null", () => {
    const schema = string({ nullable: true });
    const result = schema["~standard"].validate(null);
    expect(result.issues).toBeUndefined();
    expect(result.value).toBe(null);
  });

  test("default provides fallback", () => {
    const schema = string({ default: "default" });
    const result = schema["~standard"].validate(undefined);
    expect(result.issues).toBeUndefined();
    expect(result.value).toBe("default");
  });

  test("default with factory function", () => {
    let counter = 0;
    const schema = number({ default: () => ++counter });
    expect(schema["~standard"].validate(undefined).value).toBe(1);
    expect(schema["~standard"].validate(undefined).value).toBe(2);
  });

  test("array validates array of type", () => {
    const schema = string({ array: true });
    const result = schema["~standard"].validate(["a", "b", "c"]);
    expect(result.issues).toBeUndefined();
    expect(result.value).toEqual(["a", "b", "c"]);
  });

  test("array rejects non-arrays", () => {
    const schema = string({ array: true });
    expect(schema["~standard"].validate("a").issues).toBeDefined();
  });

  test("array validates each item", () => {
    const schema = number({ array: true });
    expect(schema["~standard"].validate([1, "2", 3]).issues).toBeDefined();
  });

  test("transform applies to output", () => {
    const schema = string({ transform: (s) => s.toUpperCase() });
    const result = schema["~standard"].validate("hello");
    expect(result.value).toBe("HELLO");
  });
});

// =============================================================================
// Wrapper Schema Tests
// =============================================================================

describe("array wrapper", () => {
  const schema = array(number());

  test("validates arrays", () => {
    const result = schema["~standard"].validate([1, 2, 3]);
    expect(result.issues).toBeUndefined();
    expect(result.value).toEqual([1, 2, 3]);
  });

  test("validates empty arrays", () => {
    const result = schema["~standard"].validate([]);
    expect(result.issues).toBeUndefined();
    expect(result.value).toEqual([]);
  });

  test("rejects invalid items", () => {
    const result = schema["~standard"].validate([1, "2", 3]);
    expect(result.issues).toBeDefined();
  });

  test("type inference", () => {
    type Output = StandardSchemaV1.InferOutput<typeof schema>;
    expectTypeOf<Output>().toEqualTypeOf<number[]>();
  });
});

describe("nullable wrapper", () => {
  const schema = nullable(string());

  test("allows null", () => {
    const result = schema["~standard"].validate(null);
    expect(result.issues).toBeUndefined();
    expect(result.value).toBe(null);
  });

  test("passes through value", () => {
    const result = schema["~standard"].validate("hello");
    expect(result.issues).toBeUndefined();
    expect(result.value).toBe("hello");
  });

  test("with default", () => {
    const schemaWithDefault = nullable(string(), "default");
    const result = schemaWithDefault["~standard"].validate(null);
    expect(result.value).toBe("default");
  });

  test("type inference", () => {
    type Output = StandardSchemaV1.InferOutput<typeof schema>;
    expectTypeOf<Output>().toEqualTypeOf<string | null>();
  });
});

describe("optional wrapper", () => {
  const schema = optional(number());

  test("allows undefined", () => {
    const result = schema["~standard"].validate(undefined);
    expect(result.issues).toBeUndefined();
    expect(result.value).toBe(undefined);
  });

  test("passes through value", () => {
    const result = schema["~standard"].validate(42);
    expect(result.issues).toBeUndefined();
    expect(result.value).toBe(42);
  });

  test("with default", () => {
    const schemaWithDefault = optional(number(), 0);
    const result = schemaWithDefault["~standard"].validate(undefined);
    expect(result.value).toBe(0);
  });

  test("type inference", () => {
    type Output = StandardSchemaV1.InferOutput<typeof schema>;
    expectTypeOf<Output>().toEqualTypeOf<number | undefined>();
  });
});

// =============================================================================
// Object Schema Tests
// =============================================================================

describe("object schema", () => {
  const schema = object({
    name: string(),
    age: number(),
  });

  test("validates objects", () => {
    const result = schema["~standard"].validate({ name: "Alice", age: 30 });
    expect(result.issues).toBeUndefined();
    expect(result.value).toEqual({ name: "Alice", age: 30 });
  });

  test("rejects unknown keys by default (strict: true)", () => {
    const result = schema["~standard"].validate({
      name: "Alice",
      age: 30,
      extra: true,
    });
    expect(result.issues).toBeDefined();
    expect(result.issues![0].message).toContain("Unknown key");
  });

  test("allows unknown keys with strict: false", () => {
    const looseSchema = object(
      { name: string(), age: number() },
      { strict: false }
    );
    const result = looseSchema["~standard"].validate({
      name: "Alice",
      age: 30,
      extra: true,
    });
    expect(result.issues).toBeUndefined();
    expect(result.value).toEqual({ name: "Alice", age: 30 });
  });

  test("rejects missing required fields", () => {
    const result = schema["~standard"].validate({ name: "Alice" });
    expect(result.issues).toBeDefined();
    expect(result.issues![0].message).toContain("age");
  });

  test("handles optional fields", () => {
    const schemaWithOptional = object({
      name: string(),
      age: optional(number()),
    });
    const result = schemaWithOptional["~standard"].validate({ name: "Alice" });
    expect(result.issues).toBeUndefined();
    expect(result.value).toEqual({ name: "Alice", age: undefined });
  });

  test("type inference", () => {
    type Output = StandardSchemaV1.InferOutput<typeof schema>;
    expectTypeOf<Output>().toEqualTypeOf<{ name: string; age: number }>();
  });
});

describe("object with partial option", () => {
  const partialUser = object(
    { name: string(), age: number() },
    { partial: true }
  );

  test("allows missing fields", () => {
    const result = partialUser["~standard"].validate({ name: "Alice" });
    expect(result.issues).toBeUndefined();
    expect(result.value).toEqual({ name: "Alice", age: undefined });
  });

  test("allows empty object", () => {
    const result = partialUser["~standard"].validate({});
    expect(result.issues).toBeUndefined();
    expect(result.value).toEqual({ name: undefined, age: undefined });
  });

  test("still validates provided fields", () => {
    const result = partialUser["~standard"].validate({ name: 123 });
    expect(result.issues).toBeDefined();
  });
});

describe("object with other options", () => {
  test("optional object", () => {
    const optionalUser = object({ name: string() }, { optional: true });
    expect(optionalUser["~standard"].validate(undefined).value).toBeUndefined();
    expect(optionalUser["~standard"].validate({ name: "A" }).value).toEqual({
      name: "A",
    });
  });

  test("nullable object", () => {
    const nullableUser = object({ name: string() }, { nullable: true });
    expect(nullableUser["~standard"].validate(null).value).toBeNull();
  });

  test("array of objects", () => {
    const users = object({ name: string() }, { array: true });
    const result = users["~standard"].validate([{ name: "A" }, { name: "B" }]);
    expect(result.issues).toBeUndefined();
    expect(result.value).toEqual([{ name: "A" }, { name: "B" }]);
  });

  test("object with default", () => {
    const userWithDefault = object(
      { name: string() },
      { optional: true, default: { name: "Unknown" } }
    );
    expect(userWithDefault["~standard"].validate(undefined).value).toEqual({
      name: "Unknown",
    });
  });

  test("object with transform", () => {
    const upperUser = object(
      { name: string() },
      { transform: (u) => ({ ...u, name: u.name.toUpperCase() }) }
    );
    expect(upperUser["~standard"].validate({ name: "alice" }).value).toEqual({
      name: "ALICE",
    });
  });
});

// =============================================================================
// Composition Tests
// =============================================================================

describe("union schema", () => {
  const schema = union([string(), number()]);

  test("validates first matching option", () => {
    expect(schema["~standard"].validate("hello").value).toBe("hello");
    expect(schema["~standard"].validate(42).value).toBe(42);
  });

  test("rejects non-matching values", () => {
    const result = schema["~standard"].validate(true);
    expect(result.issues).toBeDefined();
  });

  test("type inference", () => {
    type Output = StandardSchemaV1.InferOutput<typeof schema>;
    expectTypeOf<Output>().toEqualTypeOf<string | number>();
  });
});

// =============================================================================
// Date & Time Schema Tests
// =============================================================================

describe("date schema", () => {
  const schema = date();

  test("validates Date objects", () => {
    const d = new Date();
    const result = schema["~standard"].validate(d);
    expect(result.issues).toBeUndefined();
    expect(result.value).toEqual(d);
  });

  test("rejects invalid dates", () => {
    expect(
      schema["~standard"].validate(new Date("invalid")).issues
    ).toBeDefined();
  });

  test("rejects non-dates", () => {
    expect(schema["~standard"].validate("2023-01-01").issues).toBeDefined();
    expect(schema["~standard"].validate(123456789).issues).toBeDefined();
  });
});

describe("isoTimestamp schema", () => {
  const schema = isoTimestamp();

  test("validates ISO timestamps", () => {
    const result = schema["~standard"].validate("2023-12-15T10:30:00.000Z");
    expect(result.issues).toBeUndefined();
    expect(result.value).toBe("2023-12-15T10:30:00.000Z");
  });

  test("rejects invalid formats", () => {
    expect(schema["~standard"].validate("2023-12-15").issues).toBeDefined();
    expect(schema["~standard"].validate("not-a-date").issues).toBeDefined();
  });
});

describe("isoDate schema", () => {
  const schema = isoDate();

  test("validates ISO dates", () => {
    const result = schema["~standard"].validate("2023-12-15");
    expect(result.issues).toBeUndefined();
    expect(result.value).toBe("2023-12-15");
  });

  test("rejects invalid formats", () => {
    expect(
      schema["~standard"].validate("2023-12-15T10:30:00Z").issues
    ).toBeDefined();
    expect(schema["~standard"].validate("12/15/2023").issues).toBeDefined();
  });
});

describe("isoTime schema", () => {
  const schema = isoTime();

  test("validates ISO times", () => {
    const result = schema["~standard"].validate("10:30:00");
    expect(result.issues).toBeUndefined();
    expect(result.value).toBe("10:30:00");
  });

  test("rejects invalid formats", () => {
    expect(schema["~standard"].validate("10:30").issues).toBeDefined();
    expect(schema["~standard"].validate("25:00:00").issues).toBeDefined();
  });
});

// =============================================================================
// Instance Schema Tests
// =============================================================================

describe("instance schema", () => {
  const schema = instance(Uint8Array);

  test("validates instances", () => {
    const arr = new Uint8Array([1, 2, 3]);
    const result = schema["~standard"].validate(arr);
    expect(result.issues).toBeUndefined();
    expect(result.value).toEqual(arr);
  });

  test("rejects non-instances", () => {
    expect(schema["~standard"].validate([1, 2, 3]).issues).toBeDefined();
    expect(schema["~standard"].validate("buffer").issues).toBeDefined();
  });

  test("type inference", () => {
    type Output = StandardSchemaV1.InferOutput<typeof schema>;
    expectTypeOf<Output>().toEqualTypeOf<Uint8Array>();
  });
});

describe("blob pattern (union of instances)", () => {
  const blobSchema = union([instance(Uint8Array), instance(Buffer)]);

  test("validates Uint8Array", () => {
    const arr = new Uint8Array([1, 2, 3]);
    const result = blobSchema["~standard"].validate(arr);
    expect(result.issues).toBeUndefined();
  });

  test("validates Buffer", () => {
    const buf = Buffer.from([1, 2, 3]);
    const result = blobSchema["~standard"].validate(buf);
    expect(result.issues).toBeUndefined();
  });
});

describe("pipe schema", () => {
  const schema = pipe(
    string(),
    transform((s) => s.trim()),
    transform((s) => s.toUpperCase())
  );

  test("applies transforms in order", () => {
    const result = schema["~standard"].validate("  hello  ");
    expect(result.value).toBe("HELLO");
  });

  test("validates base first", () => {
    const result = schema["~standard"].validate(123);
    expect(result.issues).toBeDefined();
  });
});

describe("record schema", () => {
  const schema = record(string(), number());

  test("validates records", () => {
    const result = schema["~standard"].validate({ a: 1, b: 2 });
    expect(result.issues).toBeUndefined();
    expect(result.value).toEqual({ a: 1, b: 2 });
  });

  test("rejects invalid values", () => {
    const result = schema["~standard"].validate({ a: "1" });
    expect(result.issues).toBeDefined();
  });

  test("type inference", () => {
    type Output = StandardSchemaV1.InferOutput<typeof schema>;
    expectTypeOf<Output>().toEqualTypeOf<Record<string, number>>();
  });
});

// =============================================================================
// Circular Reference Tests (using thunks, not lazy)
// =============================================================================

describe("circular references with thunks", () => {
  test("self-reference works", () => {
    const selfRef = object({
      name: string(),
      self: optional(() => selfRef), // Thunk for self-reference
    });

    const result = selfRef["~standard"].validate({
      name: "root",
      self: { name: "child" },
    });
    expect(result.issues).toBeUndefined();
  });

  test("mutual references work", () => {
    const user = object({
      name: string(),
      posts: array(() => post), // Thunk for forward reference
    });

    const post = object({
      title: string(),
      author: () => user, // Thunk for back reference
    });

    const result = user["~standard"].validate({
      name: "Alice",
      posts: [{ title: "Hello", author: { name: "Alice", posts: [] } }],
    });
    expect(result.issues).toBeUndefined();
  });

  test("type inference with circular references", () => {
    const user = object({
      name: string(),
      friend: () => user,
    });

    type UserOutput = StandardSchemaV1.InferOutput<typeof user>;

    // This should not be `any`
    type IsAny<T> = 0 extends 1 & T ? true : false;
    type _CheckNotAny = IsAny<UserOutput> extends false ? true : never;
    const _check: _CheckNotAny = true;
  });
});

// =============================================================================
// Namespace Tests
// =============================================================================

describe("v namespace", () => {
  test("all schemas available", () => {
    // Scalars
    expect(v.string).toBeDefined();
    expect(v.number).toBeDefined();
    expect(v.integer).toBeDefined();
    expect(v.boolean).toBeDefined();
    expect(v.bigint).toBeDefined();
    expect(v.literal).toBeDefined();
    // Date & Time
    expect(v.date).toBeDefined();
    expect(v.isoTimestamp).toBeDefined();
    expect(v.isoDate).toBeDefined();
    expect(v.isoTime).toBeDefined();
    // Instance
    expect(v.instance).toBeDefined();
    // Wrappers
    expect(v.array).toBeDefined();
    expect(v.nullable).toBeDefined();
    expect(v.optional).toBeDefined();
    // Objects
    expect(v.object).toBeDefined();
    // Composition
    expect(v.union).toBeDefined();
    expect(v.pipe).toBeDefined();
    expect(v.transform).toBeDefined();
    expect(v.record).toBeDefined();
  });
});
