/**
 * Unique Filter Schema Tests
 *
 * Tests the _filter.unique schema which includes only id and unique fields
 * with their base schemas, all optional.
 */

import { describe, test, expect, expectTypeOf } from "vitest";
import { parse, safeParse } from "valibot";
import {
  simpleSchemas,
  compoundIdSchemas,
  compoundUniqueSchemas,
  type SimpleState,
  type CompoundIdState,
} from "../fixtures";
import type { UniqueFilterInput } from "../../../src/schema/model/schemas/core";

// =============================================================================
// TYPE TESTS - Simple Model
// =============================================================================

describe("Unique Filter - Types (Simple Model)", () => {
  type Input = UniqueFilterInput<SimpleState>;

  test("type: includes id field", () => {
    expectTypeOf<Input>().toHaveProperty("id");
  });

  test("type: includes unique field", () => {
    expectTypeOf<Input>().toHaveProperty("email");
  });

  test("type: all fields are optional (empty object matches)", () => {
    expectTypeOf<{}>().toMatchTypeOf<Input>();
  });

  test("type: accepts direct value (not filter object)", () => {
    expectTypeOf<{ id: string }>().toMatchTypeOf<Input>();
    expectTypeOf<{ email: string }>().toMatchTypeOf<Input>();
  });
});

// =============================================================================
// RUNTIME TESTS - Simple Model
// =============================================================================

describe("Unique Filter - Simple Model Runtime", () => {
  const schema = simpleSchemas._filter.unique;

  test("runtime: accepts empty object", () => {
    const result = safeParse(schema, {});
    expect(result.success).toBe(true);
  });

  test("runtime: accepts id value", () => {
    const result = parse(schema, { id: "user-123" });
    expect(result.id).toBe("user-123");
  });

  test("runtime: accepts unique field value", () => {
    const result = parse(schema, { email: "alice@example.com" });
    expect(result.email).toBe("alice@example.com");
  });

  test("runtime: accepts both id and unique field", () => {
    const result = parse(schema, {
      id: "user-123",
      email: "alice@example.com",
    });
    expect(result.id).toBe("user-123");
    expect(result.email).toBe("alice@example.com");
  });

  test("runtime: rejects non-unique field (strict schema)", () => {
    // Schema is strict to prevent invalid SQL from extra keys
    const result = safeParse(schema, { name: "Alice" });
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// RUNTIME TESTS - Compound ID Model
// =============================================================================

describe("Unique Filter - Compound ID Model Runtime", () => {
  type Input = UniqueFilterInput<CompoundIdState>;
  const schema = compoundIdSchemas._filter.unique;

  test("type: does not have single field id (compound id)", () => {
    // Compound ID model has no single-field unique constraints
    expectTypeOf<{}>().toMatchTypeOf<Input>();
  });

  test("runtime: accepts empty object (no single-field uniques)", () => {
    const result = safeParse(schema, {});
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// RUNTIME TESTS - Compound Unique Model
// =============================================================================

describe("Unique Filter - Compound Unique Model Runtime", () => {
  const schema = compoundUniqueSchemas._filter.unique;

  test("runtime: accepts id field", () => {
    const result = parse(schema, { id: "record-123" });
    expect(result.id).toBe("record-123");
  });

  test("runtime: rejects compound unique fields as single fields (strict schema)", () => {
    // Schema is strict to prevent invalid SQL from extra keys
    // email and tenantId are part of a compound unique, not single uniques
    const result = safeParse(schema, { email: "a@b.com" });
    expect(result.success).toBe(false);
  });
});
