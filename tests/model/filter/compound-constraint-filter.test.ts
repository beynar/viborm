/**
 * Compound Constraint Filter Schema Tests
 *
 * Tests the _filter.compoundConstraint schema which includes both
 * compound ID and compound unique constraints.
 */

import { describe, test, expect, expectTypeOf } from "vitest";
import { parse, safeParse } from "valibot";
import {
  compoundIdSchemas,
  compoundUniqueSchemas,
  simpleSchemas,
  type CompoundIdState,
  type CompoundUniqueState,
} from "../fixtures";

// =============================================================================
// RUNTIME TESTS - Compound ID Model
// =============================================================================

describe("Compound Constraint Filter - Compound ID Model Runtime", () => {
  const schema = compoundIdSchemas._filter.compoundConstraint;

  test("runtime: accepts empty object", () => {
    const result = safeParse(schema, {});
    expect(result.success).toBe(true);
  });

  test("runtime: accepts compound ID key", () => {
    const result = safeParse(schema, {
      orgId_memberId: { orgId: "org-1", memberId: "member-1" },
    });
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

describe("Compound Constraint Filter - Compound Unique Model Runtime", () => {
  const schema = compoundUniqueSchemas._filter.compoundConstraint;

  test("runtime: accepts empty object", () => {
    const result = safeParse(schema, {});
    expect(result.success).toBe(true);
  });

  test("runtime: accepts compound unique key", () => {
    const result = safeParse(schema, {
      email_tenantId: { email: "a@b.com", tenantId: "tenant-1" },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: compound unique requires all fields", () => {
    const result = safeParse(schema, {
      email_tenantId: { email: "a@b.com" }, // missing tenantId
    });
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// RUNTIME TESTS - Simple Model (no compound constraints)
// =============================================================================

describe("Compound Constraint Filter - Simple Model Runtime", () => {
  const schema = simpleSchemas._filter.compoundConstraint;

  test("runtime: accepts empty object", () => {
    const result = safeParse(schema, {});
    expect(result.success).toBe(true);
  });

  test("runtime: ignores unknown key (Valibot allows extra keys)", () => {
    // Valibot's partial/object allows extra keys by default
    const result = safeParse(schema, { anyKey: {} });
    expect(result.success).toBe(true);
  });
});

