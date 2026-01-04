/**
 * Unique Filter Schema Tests
 *
 * Tests the _filter.unique schema which includes only id and unique fields
 * with their base schemas, all optional.
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

describe("Unique Filter - Types (Simple Model)", () => {
  type Input = InferInput<typeof simpleSchemas._filter.unique>;

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
    const result = parse(schema, {});
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts id value", () => {
    const result = parse(schema, { id: "user-123" });
    if (result.issues) throw new Error("Expected success");
    expect(result.value.id).toBe("user-123");
  });

  test("runtime: accepts unique field value", () => {
    const result = parse(schema, { email: "alice@example.com" });
    if (result.issues) throw new Error("Expected success");
    expect(result.value.email).toBe("alice@example.com");
  });

  test("runtime: accepts both id and unique field", () => {
    const result = parse(schema, {
      id: "user-123",
      email: "alice@example.com",
    });
    if (result.issues) throw new Error("Expected success");
    expect(result.value.id).toBe("user-123");
    expect(result.value.email).toBe("alice@example.com");
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

describe("Unique Filter - Compound ID Model Runtime", () => {
  type Input = InferInput<typeof compoundIdSchemas._filter.unique>;
  const schema = compoundIdSchemas._filter.unique;

  test("type: does not have single field id (compound id)", () => {
    // Compound ID model has no single-field unique constraints
    expectTypeOf<{}>().toMatchTypeOf<Input>();
  });

  test("runtime: accepts empty object (no single-field uniques)", () => {
    const result = parse(schema, {});
    expect(result.issues).toBeUndefined();
  });
});

// =============================================================================
// RUNTIME TESTS - Compound Unique Model
// =============================================================================

describe("Unique Filter - Compound Unique Model Runtime", () => {
  const schema = compoundUniqueSchemas._filter.unique;

  test("runtime: accepts id field", () => {
    const result = parse(schema, { id: "record-123" });
    if (result.issues) throw new Error("Expected success");
    expect(result.value.id).toBe("record-123");
  });

  test("runtime: rejects compound unique fields as single fields (strict schema)", () => {
    // Schema is strict to prevent invalid SQL from extra keys
    // email and tenantId are part of a compound unique, not single uniques
    const result = parse(schema, { email: "a@b.com" });
    expect(result.issues).toBeDefined();
  });
});
