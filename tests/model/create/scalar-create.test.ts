/**
 * Scalar Create Schema Tests
 *
 * Tests the _create.scalar schema which includes all scalar fields
 * with their create schemas (required vs optional based on defaults/auto).
 */

import { describe, test, expect, expectTypeOf } from "vitest";
import { parse, safeParse } from "valibot";
import {
  simpleSchemas,
  compoundIdSchemas,
  type SimpleState,
  type CompoundIdState,
} from "../fixtures";
import type { ScalarCreateInput } from "../../../src/schema/model/schemas/core";

// =============================================================================
// TYPE TESTS - Simple Model
// =============================================================================

describe("Scalar Create - Types (Simple Model)", () => {
  type Input = ScalarCreateInput<SimpleState>;

  test("type: includes all scalar fields", () => {
    expectTypeOf<Input>().toHaveProperty("id");
    expectTypeOf<Input>().toHaveProperty("name");
    expectTypeOf<Input>().toHaveProperty("email");
    expectTypeOf<Input>().toHaveProperty("age");
    expectTypeOf<Input>().toHaveProperty("active");
  });

  test("type: required fields are required", () => {
    expectTypeOf<{ id: string; name: string; email: string }>().toMatchTypeOf<
      Pick<Input, "id" | "name" | "email">
    >();
  });
});

// =============================================================================
// RUNTIME TESTS - Simple Model
// =============================================================================

describe("Scalar Create - Simple Model Runtime", () => {
  const schema = simpleSchemas._create.scalar;

  test("runtime: accepts valid input with all required fields", () => {
    const result = safeParse(schema, {
      id: "user-123",
      name: "Alice",
      email: "alice@example.com",
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts optional field (age nullable)", () => {
    const result = parse(schema, {
      id: "user-123",
      name: "Alice",
      email: "alice@example.com",
      age: 25,
    });
    expect(result.age).toBe(25);
  });

  test("runtime: accepts null for nullable field", () => {
    const result = parse(schema, {
      id: "user-123",
      name: "Alice",
      email: "alice@example.com",
      age: null,
    });
    expect(result.age).toBe(null);
  });

  test("runtime: field with default can be omitted", () => {
    const result = safeParse(schema, {
      id: "user-123",
      name: "Alice",
      email: "alice@example.com",
      // active has default(true), so it can be omitted
    });
    expect(result.success).toBe(true);
  });

  test("runtime: rejects missing required field", () => {
    const result = safeParse(schema, {
      id: "user-123",
      // missing name and email
    });
    expect(result.success).toBe(false);
  });

  test("runtime: rejects wrong type", () => {
    const result = safeParse(schema, {
      id: "user-123",
      name: 123, // should be string
      email: "alice@example.com",
    });
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// RUNTIME TESTS - Compound ID Model
// =============================================================================

describe("Scalar Create - Compound ID Model Runtime", () => {
  const schema = compoundIdSchemas._create.scalar;

  test("runtime: accepts all fields", () => {
    const result = safeParse(schema, {
      orgId: "org-1",
      memberId: "member-1",
      role: "admin",
    });
    expect(result.success).toBe(true);
  });

  test("runtime: rejects missing compound id fields", () => {
    const result = safeParse(schema, {
      orgId: "org-1",
      // missing memberId and role
    });
    expect(result.success).toBe(false);
  });
});

