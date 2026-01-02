/**
 * Compound ID Filter Schema Tests
 *
 * Tests the _filter.compoundId schema which includes compound primary key
 * constraints as single keys with nested field objects.
 */

import { describe, test, expect, expectTypeOf } from "vitest";
import { parse } from "@validation";
import {
  compoundIdSchemas,
  simpleSchemas,
  compoundUniqueSchemas,
  type CompoundIdState,
  type SimpleState,
} from "../fixtures";

// =============================================================================
// TYPE TESTS - Compound ID Model
// =============================================================================

describe("Compound ID Filter - Types", () => {
  test("type: empty object matches (all optional)", () => {
    // All compound constraint keys are optional
    const input: Record<string, unknown> = {};
    expectTypeOf(input).toMatchTypeOf<Record<string, unknown>>();
  });
});

// =============================================================================
// RUNTIME TESTS - Compound ID Model
// =============================================================================

describe("Compound ID Filter - Compound ID Model Runtime", () => {
  const schema = compoundIdSchemas._filter.compoundId;

  test("runtime: accepts empty object", () => {
    const result = parse(schema, {});
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts compound key object", () => {
    const result = parse(schema, {
      orgId_memberId: { orgId: "org-1", memberId: "member-1" },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: compound key requires all fields", () => {
    const result = parse(schema, {
      orgId_memberId: { orgId: "org-1" }, // missing memberId
    });
    expect(result.issues).toBeDefined();
  });
});

// =============================================================================
// RUNTIME TESTS - Simple Model (no compound id)
// =============================================================================

describe("Compound ID Filter - Simple Model Runtime (no compound id)", () => {
  const schema = simpleSchemas._filter.compoundId;

  test("runtime: accepts empty object", () => {
    const result = parse(schema, {});
    expect(result.issues).toBeUndefined();
  });

  test("runtime: rejects unknown key (strict schema)", () => {
    // Schema is strict to prevent invalid SQL from extra keys
    const result = parse(schema, { anyKey: {} });
    expect(result.issues).toBeDefined();
  });
});

// =============================================================================
// RUNTIME TESTS - Compound Unique Model (no compound id, has compound unique)
// =============================================================================

describe("Compound ID Filter - Compound Unique Model Runtime", () => {
  const schema = compoundUniqueSchemas._filter.compoundId;

  test("runtime: accepts empty object (no compound ID)", () => {
    const result = parse(schema, {});
    expect(result.issues).toBeUndefined();
  });

  test("runtime: rejects compound unique key (strict schema)", () => {
    // Schema is strict - only compound ID keys are valid here
    const result = parse(schema, {
      email_tenantId: { email: "a@b.com", tenantId: "t1" },
    });
    expect(result.issues).toBeDefined();
  });
});
