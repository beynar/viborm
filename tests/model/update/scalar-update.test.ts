/**
 * Scalar Update Schema Tests
 *
 * Tests the _update.scalar schema which includes all scalar fields
 * with their update schemas (all optional, with set/increment operations).
 */

import { describe, test, expect, expectTypeOf } from "vitest";
import { parse, safeParse } from "valibot";
import {
  simpleSchemas,
  compoundIdSchemas,
  type SimpleState,
} from "../fixtures";
import type { ScalarUpdateInput } from "../../../src/schema/model/schemas/core";

// =============================================================================
// TYPE TESTS - Simple Model
// =============================================================================

describe("Scalar Update - Types (Simple Model)", () => {
  type Input = ScalarUpdateInput<SimpleState>;

  test("type: includes all scalar fields", () => {
    expectTypeOf<Input>().toHaveProperty("id");
    expectTypeOf<Input>().toHaveProperty("name");
    expectTypeOf<Input>().toHaveProperty("email");
    expectTypeOf<Input>().toHaveProperty("age");
    expectTypeOf<Input>().toHaveProperty("active");
  });

  test("type: all fields are optional (empty object matches)", () => {
    expectTypeOf<{}>().toMatchTypeOf<Input>();
  });
});

// =============================================================================
// RUNTIME TESTS - Simple Model
// =============================================================================

describe("Scalar Update - Simple Model Runtime", () => {
  const schema = simpleSchemas._update.scalar;

  test("runtime: accepts empty object", () => {
    const result = safeParse(schema, {});
    expect(result.success).toBe(true);
  });

  test("runtime: accepts shorthand value", () => {
    const result = parse(schema, { name: "Bob" });
    expect(result.name).toEqual({ set: "Bob" });
  });

  test("runtime: accepts explicit set", () => {
    const result = parse(schema, { name: { set: "Bob" } });
    expect(result.name).toEqual({ set: "Bob" });
  });

  test("runtime: accepts multiple fields", () => {
    const result = parse(schema, {
      name: "Bob",
      email: "bob@example.com",
    });
    expect(result.name).toEqual({ set: "Bob" });
    expect(result.email).toEqual({ set: "bob@example.com" });
  });

  test("runtime: accepts null for nullable field", () => {
    const result = parse(schema, { age: null });
    expect(result.age).toEqual({ set: null });
  });

  test("runtime: accepts increment for number field", () => {
    const result = parse(schema, { age: { increment: 1 } });
    expect(result.age).toEqual({ increment: 1 });
  });

  test("runtime: accepts decrement for number field", () => {
    const result = parse(schema, { age: { decrement: 1 } });
    expect(result.age).toEqual({ decrement: 1 });
  });

  test("runtime: rejects unknown field (strict schema)", () => {
    // Schema is strict to prevent invalid SQL from extra keys
    const result = safeParse(schema, { unknownField: "value" });
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// RUNTIME TESTS - Compound ID Model
// =============================================================================

describe("Scalar Update - Compound ID Model Runtime", () => {
  const schema = compoundIdSchemas._update.scalar;

  test("runtime: accepts update to any scalar field", () => {
    const result = parse(schema, { role: "member" });
    expect(result.role).toEqual({ set: "member" });
  });

  test("runtime: can update compound id fields (if allowed by business logic)", () => {
    // Schema allows it; business logic may restrict it
    const result = safeParse(schema, { orgId: "new-org" });
    expect(result.success).toBe(true);
  });
});

