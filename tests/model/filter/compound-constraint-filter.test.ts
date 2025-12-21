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
    if (result.success) {
      expect(result.output).toEqual({});
    }
  });

  test("runtime: accepts compound ID key", () => {
    const result = safeParse(schema, {
      orgId_memberId: { orgId: "org-1", memberId: "member-1" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.orgId_memberId).toEqual({
        orgId: "org-1",
        memberId: "member-1",
      });
    }
  });

  test("output: preserves all compound ID fields", () => {
    const input = {
      orgId_memberId: { orgId: "org-123", memberId: "member-456" },
    };
    const result = safeParse(schema, input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.orgId_memberId?.orgId).toBe("org-123");
      expect(result.output.orgId_memberId?.memberId).toBe("member-456");
    }
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
    if (result.success) {
      expect(result.output).toEqual({});
    }
  });

  test("runtime: accepts compound unique key", () => {
    const result = safeParse(schema, {
      email_tenantId: { email: "a@b.com", tenantId: "tenant-1" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.email_tenantId).toEqual({
        email: "a@b.com",
        tenantId: "tenant-1",
      });
    }
  });

  test("output: preserves all compound unique fields", () => {
    const input = {
      email_tenantId: { email: "test@example.com", tenantId: "tenant-xyz" },
    };
    const result = safeParse(schema, input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.email_tenantId?.email).toBe("test@example.com");
      expect(result.output.email_tenantId?.tenantId).toBe("tenant-xyz");
    }
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
    if (result.success) {
      expect(result.output).toEqual({});
    }
  });

  test("output: returns empty object for model without compound constraints", () => {
    const result = safeParse(schema, {});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.keys(result.output)).toHaveLength(0);
    }
  });

  test("runtime: ignores unknown key (Valibot allows extra keys)", () => {
    // Valibot's partial/object allows extra keys by default
    const result = safeParse(schema, { anyKey: {} });
    expect(result.success).toBe(true);
  });
});
