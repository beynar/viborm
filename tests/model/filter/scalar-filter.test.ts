/**
 * Scalar Filter Schema Tests
 *
 * Tests the _filter.scalar schema which includes all scalar fields
 * with their respective filter schemas, all optional.
 */

import { type InferInput, parse } from "@validation";
import { describe, expect, expectTypeOf, test } from "vitest";
import { compoundIdSchemas, simpleSchemas } from "../fixtures";

// =============================================================================
// TYPE TESTS
// =============================================================================

describe("Scalar Filter - Types", () => {
  type Input = InferInput<typeof simpleSchemas.scalarFilter>;

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

  test("type: accepts shorthand string filter", () => {
    expectTypeOf<{ name: string }>().toMatchTypeOf<Input>();
  });

  test("type: accepts shorthand number filter", () => {
    expectTypeOf<{ age: number }>().toMatchTypeOf<Input>();
  });

  test("type: accepts shorthand boolean filter", () => {
    expectTypeOf<{ active: boolean }>().toMatchTypeOf<Input>();
  });
});

// =============================================================================
// RUNTIME TESTS - Simple Model
// =============================================================================

describe("Scalar Filter - Simple Model Runtime", () => {
  const schema = simpleSchemas.scalarFilter;

  test("runtime: accepts empty object", () => {
    const result = parse(schema, {});
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts single field shorthand", () => {
    const result = parse(schema, { name: "Alice" });
    if (result.issues) throw new Error("Expected success");
    expect(result.value.name).toEqual({ equals: "Alice" });
  });

  test("runtime: accepts multiple field filters", () => {
    const result = parse(schema, {
      name: "Alice",
      active: true,
    });
    if (result.issues) throw new Error("Expected success");
    expect(result.value.name).toEqual({ equals: "Alice" });
    expect(result.value.active).toEqual({ equals: true });
  });

  test("runtime: accepts complex filter object", () => {
    const result = parse(schema, {
      age: { gte: 18, lte: 65 },
    });
    if (result.issues) throw new Error("Expected success");
    expect(result.value.age).toEqual({ gte: 18, lte: 65 });
  });

  test("runtime: accepts string filter with operators", () => {
    const result = parse(schema, {
      name: { startsWith: "A", endsWith: "e" },
    });
    if (result.issues) throw new Error("Expected success");
    expect(result.value.name).toEqual({ startsWith: "A", endsWith: "e" });
  });

  test("runtime: accepts nullable field filter", () => {
    const result = parse(schema, { age: null });
    if (result.issues) throw new Error("Expected success");
    expect(result.value.age).toEqual({ equals: null });
  });

  test("runtime: accepts 'in' array filter", () => {
    const result = parse(schema, {
      name: { in: ["Alice", "Bob"] },
    });
    if (result.issues) throw new Error("Expected success");
    expect(result.value.name).toEqual({ in: ["Alice", "Bob"] });
  });

  test("runtime: accepts NOT filter", () => {
    const result = parse(schema, {
      name: { not: "Admin" },
    });
    if (result.issues) throw new Error("Expected success");
    expect(result.value.name).toEqual({ not: { equals: "Admin" } });
  });

  test("runtime: rejects unknown field (strict schema)", () => {
    // Schema is strict to prevent invalid SQL from extra keys
    const result = parse(schema, { unknownField: "value" });
    expect(result.issues).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // Arbitrarily nested NOT. `not` is lazily self-referential (see
  // src/validation/scalars/negatable-filter.ts), so validation no longer caps
  // nesting at one level — matching both Prisma and the where-builder, which
  // has always recursed without a cap.
  // ---------------------------------------------------------------------------

  test("runtime: accepts doubly nested NOT", () => {
    const result = parse(schema, {
      name: { not: { not: { contains: "Admin" } } },
    });
    if (result.issues) throw new Error("Expected success");
    expect(result.value.name).toEqual({ not: { not: { contains: "Admin" } } });
  });

  test("runtime: accepts NOT nested five deep, shorthand at the leaf", () => {
    const result = parse(schema, {
      name: { not: { not: { not: { not: { not: "Admin" } } } } },
    });
    if (result.issues) throw new Error("Expected success");
    expect(result.value.name).toEqual({
      not: { not: { not: { not: { not: { equals: "Admin" } } } } },
    });
  });

  test("runtime: nested NOT stays strict — unknown key at depth rejects", () => {
    const result = parse(schema, {
      name: { not: { not: { unknownOperator: "Admin" } } },
    });
    expect(result.issues).toBeDefined();
  });

  test("runtime: nested NOT keeps per-scalar operators — int gets no contains", () => {
    const result = parse(schema, {
      age: { not: { not: { contains: 3 } } },
    });
    expect(result.issues).toBeDefined();
  });

  test("runtime: nested NOT carries scalar type checks to the leaf", () => {
    const result = parse(schema, {
      age: { not: { not: { gt: "not-a-number" } } },
    });
    expect(result.issues).toBeDefined();
  });

  test("type: accepts arbitrarily nested NOT", () => {
    type FilterInput = InferInput<typeof simpleSchemas.scalarFilter>;
    expectTypeOf<{
      name: { not: { not: { not: { contains: string } } } };
    }>().toExtend<FilterInput>();
    expectTypeOf<{
      age: { not: { not: { gt: number } } };
    }>().toExtend<FilterInput>();
  });
});

// =============================================================================
// RUNTIME TESTS - Compound ID Model
// =============================================================================

describe("Scalar Filter - Compound ID Model Runtime", () => {
  const schema = compoundIdSchemas.scalarFilter;

  test("runtime: includes all scalar fields from compound id model", () => {
    const result = parse(schema, {
      orgId: "org-1",
      memberId: "member-1",
      role: "admin",
    });
    if (result.issues) throw new Error("Expected success");
    expect(result.value.orgId).toEqual({ equals: "org-1" });
    expect(result.value.memberId).toEqual({ equals: "member-1" });
    expect(result.value.role).toEqual({ equals: "admin" });
  });
});
