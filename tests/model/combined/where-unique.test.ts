/**
 * Where Unique Schema Tests
 *
 * Tests the whereUnique schema which includes single-field unique
 * constraints and compound constraints.
 */

import { type InferInput, parse } from "@validation";
import { describe, expect, expectTypeOf, test } from "vitest";
import {
  compoundIdSchemas,
  compoundUniqueSchemas,
  simpleSchemas,
} from "../fixtures";

// =============================================================================
// TYPE TESTS - Simple Model
// =============================================================================

describe("Where Unique Schema - Types (Simple Model)", () => {
  type Input = InferInput<typeof simpleSchemas.whereUnique>;

  test("type: includes id field", () => {
    expectTypeOf<Input>().toHaveProperty("id");
  });

  test("type: includes unique field", () => {
    expectTypeOf<Input>().toHaveProperty("email");
  });

  test("type: all fields are optional", () => {
    expectTypeOf<{}>().toMatchTypeOf<Input>();
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
});
