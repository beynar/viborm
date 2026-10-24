/**
 * Where Unique Schema Tests
 *
 * Tests the whereUnique schema which includes single-field unique
 * constraints and compound constraints.
 */

import { s } from "@schema";
import {
  compoundIdSchemas,
  compoundUniqueSchemas,
  simpleSchemas,
} from "@tests/unit/operation-schemas/fixtures";
import { createSchemaRegistry, type InferInput, parse } from "@validation";
import { describe, expect, expectTypeOf, test } from "vitest";

// =============================================================================
// TYPE TESTS - Simple Model
// =============================================================================

describe("Where Unique Schema - Types (Simple Model)", () => {
  type Input = InferInput<typeof simpleSchemas.whereUnique>;
  type EmptyObject = Record<keyof any, never>;

  test("type: includes id field", () => {
    expectTypeOf<Input>().toHaveProperty("id");
  });

  test("type: includes unique field", () => {
    expectTypeOf<Input>().toHaveProperty("email");
  });

  test("type: rejects empty object", () => {
    expectTypeOf<EmptyObject>().not.toMatchTypeOf<Input>();
  });
});

// =============================================================================
// RUNTIME TESTS - Simple Model
// =============================================================================

describe("Where Unique Schema - Simple Model Runtime", () => {
  const schema = simpleSchemas.whereUnique;

  test("runtime: accepts id value", () => {
    const result = parse(schema, { id: "user-123" });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts unique field value", () => {
    const result = parse(schema, { email: "alice@example.com" });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts both id and unique field", () => {
    const result = parse(schema, {
      id: "user-123",
      email: "alice@example.com",
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: rejects non-unique field (strict schema)", () => {
    // Schema is strict to prevent invalid SQL from extra keys
    const result = parse(schema, { name: "Alice" });
    expect(result.issues).toBeDefined();
  });

  test("runtime: rejects empty object", () => {
    const result = parse(schema, {});
    expect(result.issues?.[0]?.message).toBe("Object cannot be empty");
  });
});

// =============================================================================
// RUNTIME TESTS - Compound ID Model
// =============================================================================

describe("Where Unique Schema - Compound ID Model Runtime", () => {
  const schema = compoundIdSchemas.whereUnique;

  test("runtime: accepts compound id key", () => {
    const result = parse(schema, {
      orgId_memberId: { orgId: "org-1", memberId: "member-1" },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: rejects individual compound id fields (strict schema)", () => {
    // Schema is strict - only compound key names are valid
    const result = parse(schema, { orgId: "org-1" });
    expect(result.issues).toBeDefined();
  });

  test("runtime: compound key requires all fields", () => {
    const result = parse(schema, {
      orgId_memberId: { orgId: "org-1" }, // missing memberId
    });
    expect(result.issues).toBeDefined();
  });

  test("runtime: rejects empty object", () => {
    const result = parse(schema, {});
    expect(result.issues?.[0]?.message).toBe("Object cannot be empty");
  });
});

// =============================================================================
// RUNTIME TESTS - Compound Unique Model
// =============================================================================

describe("Where Unique Schema - Compound Unique Model Runtime", () => {
  const schema = compoundUniqueSchemas.whereUnique;

  test("runtime: accepts id field", () => {
    const result = parse(schema, { id: "record-123" });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts compound unique key", () => {
    const result = parse(schema, {
      email_tenantId: { email: "a@b.com", tenantId: "tenant-1" },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts both id and compound unique", () => {
    const result = parse(schema, {
      id: "record-123",
      email_tenantId: { email: "a@b.com", tenantId: "tenant-1" },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: rejects individual compound unique fields (strict schema)", () => {
    // Schema is strict - only compound key names and id are valid
    const result = parse(schema, { email: "a@b.com" });
    expect(result.issues).toBeDefined();
  });

  test("runtime: rejects empty object", () => {
    const result = parse(schema, {});
    expect(result.issues?.[0]?.message).toBe("Object cannot be empty");
  });
});

// =============================================================================
// RUNTIME TESTS - a null selector names no row
// =============================================================================

// A unique index admits any number of NULLs, so a selector holding one matches
// every such row: `update` and `delete` wrote them all. Refused in every
// unique position, as Prisma refuses it.
const NULL_REFUSAL = /^A unique selector cannot be null/;

describe("Where Unique Schema - null selectors", () => {
  const box = s
    .model({
      id: s.int().id(),
      code: s.string().nullable().unique(),
      a: s.int(),
      b: s.string().nullable(),
    })
    .unique(["a", "b"]);
  const registry = createSchemaRegistry({ box });
  const unique = () => registry.proxy.box.core.whereUnique;
  const extended = () => registry.proxy.box.core.whereUniqueExtended;

  test.each([
    ["whereUnique", unique],
    ["whereUniqueExtended", extended],
  ] as const)("%s: refuses a nullable unique spelled null", (_, schema) => {
    const result = parse(schema(), { code: null });
    expect(result.issues?.[0]?.path).toEqual(["code"]);
    expect(result.issues?.[0]?.message).toMatch(NULL_REFUSAL);
  });

  test.each([
    ["whereUnique", unique],
    ["whereUniqueExtended", extended],
  ] as const)("%s: refuses a compound selector with a null member", (_, schema) => {
    const result = parse(schema(), { a_b: { a: 1, b: null } });
    expect(result.issues?.[0]?.path).toEqual(["a_b", "b"]);
  });

  test.each([
    ["whereUnique", unique],
    ["whereUniqueExtended", extended],
  ] as const)("%s: refuses a null even beside a selector that names the row", (_, schema) => {
    expect(parse(schema(), { id: 1, code: null }).issues?.[0]?.path).toEqual([
      "code",
    ]);
    expect(
      parse(schema(), { a_b: { a: 1, b: "x" }, code: null }).issues?.[0]?.path
    ).toEqual(["code"]);
  });

  test("accepts non-null values of nullable members", () => {
    expect(parse(unique(), { code: "c" }).issues).toBeUndefined();
    expect(parse(unique(), { a_b: { a: 1, b: "x" } }).issues).toBeUndefined();
  });
});
