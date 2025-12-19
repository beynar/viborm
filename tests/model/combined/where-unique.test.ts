/**
 * Where Unique Schema Tests
 *
 * Tests the whereUnique schema which includes single-field unique
 * constraints and compound constraints.
 */

import { describe, test, expect, expectTypeOf } from "vitest";
import { parse, safeParse } from "valibot";
import {
  simpleSchemas,
  compoundIdSchemas,
  compoundUniqueSchemas,
  type SimpleState,
  type CompoundIdState,
  type CompoundUniqueState,
} from "../fixtures";
import type { WhereUniqueInput } from "../../../src/schema/model/schemas/core";

// =============================================================================
// TYPE TESTS - Simple Model
// =============================================================================

describe("Where Unique Schema - Types (Simple Model)", () => {
  type Input = WhereUniqueInput<SimpleState>;

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
    const result = safeParse(schema, { id: "user-123" });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts unique field value", () => {
    const result = safeParse(schema, { email: "alice@example.com" });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts both id and unique field", () => {
    const result = safeParse(schema, {
      id: "user-123",
      email: "alice@example.com",
    });
    expect(result.success).toBe(true);
  });

  test("runtime: ignores non-unique field (Valibot allows extra keys)", () => {
    // Valibot's partial/object allows extra keys by default
    const result = safeParse(schema, { name: "Alice" });
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// RUNTIME TESTS - Compound ID Model
// =============================================================================

describe("Where Unique Schema - Compound ID Model Runtime", () => {
  const schema = compoundIdSchemas.whereUnique;

  test("runtime: accepts compound id key", () => {
    const result = safeParse(schema, {
      orgId_memberId: { orgId: "org-1", memberId: "member-1" },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: ignores individual compound id fields (Valibot allows extra keys)", () => {
    // Valibot's partial/object allows extra keys by default
    // Individual fields are not recognized as unique constraints
    const result = safeParse(schema, { orgId: "org-1" });
    expect(result.success).toBe(true);
  });

  test("runtime: compound key requires all fields", () => {
    const result = safeParse(schema, {
      orgId_memberId: { orgId: "org-1" }, // missing memberId
    });
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// RUNTIME TESTS - Compound Unique Model
// =============================================================================

describe("Where Unique Schema - Compound Unique Model Runtime", () => {
  const schema = compoundUniqueSchemas.whereUnique;

  test("runtime: accepts id field", () => {
    const result = safeParse(schema, { id: "record-123" });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts compound unique key", () => {
    const result = safeParse(schema, {
      email_tenantId: { email: "a@b.com", tenantId: "tenant-1" },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts both id and compound unique", () => {
    const result = safeParse(schema, {
      id: "record-123",
      email_tenantId: { email: "a@b.com", tenantId: "tenant-1" },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: ignores individual compound unique fields (Valibot allows extra keys)", () => {
    // Valibot's partial/object allows extra keys by default
    const result = safeParse(schema, { email: "a@b.com" });
    expect(result.success).toBe(true);
  });
});

