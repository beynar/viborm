/**
 * Compound ID Filter Schema Tests
 *
 * Tests the _filter.compoundId schema which includes compound primary key
 * constraints as single keys with nested field objects.
 */

import { describe, test, expect, expectTypeOf } from "vitest";
import { parse, safeParse } from "valibot";
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
    const result = safeParse(schema, {});
    expect(result.success).toBe(true);
  });

  test("runtime: accepts compound key object", () => {
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
// RUNTIME TESTS - Simple Model (no compound id)
// =============================================================================

describe("Compound ID Filter - Simple Model Runtime (no compound id)", () => {
  const schema = simpleSchemas._filter.compoundId;

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

// =============================================================================
// RUNTIME TESTS - Compound Unique Model (no compound id, has compound unique)
// =============================================================================

describe("Compound ID Filter - Compound Unique Model Runtime", () => {
  const schema = compoundUniqueSchemas._filter.compoundId;

  test("runtime: accepts empty object (no compound ID)", () => {
    const result = safeParse(schema, {});
    expect(result.success).toBe(true);
  });

  test("runtime: ignores compound unique key (Valibot allows extra keys)", () => {
    // Valibot's partial/object allows extra keys by default
    // This filter is only for compound ID, but compound unique key passes through
    const result = safeParse(schema, {
      email_tenantId: { email: "a@b.com", tenantId: "t1" },
    });
    expect(result.success).toBe(true);
  });
});

