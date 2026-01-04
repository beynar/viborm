/**
 * Compound Constraint Filter Schema Tests
 *
 * Tests the _filter.compoundConstraint schema which includes both
 * compound ID and compound unique constraints.
 */

import { parse } from "@validation";
import { describe, expect, test } from "vitest";
import {
  compoundIdSchemas,
  compoundUniqueSchemas,
  simpleSchemas,
} from "../fixtures";

// =============================================================================
// RUNTIME TESTS - Compound ID Model
// =============================================================================

describe("Compound Constraint Filter - Compound ID Model Runtime", () => {
  const schema = compoundIdSchemas._filter.compoundConstraint;

  test("runtime: accepts empty object", () => {
    const result = parse(schema, {});
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      expect(result.value).toEqual({});
    }
  });

  test("runtime: accepts compound ID key", () => {
    const result = parse(schema, {
      orgId_memberId: { orgId: "org-1", memberId: "member-1" },
    });
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      expect(result.value.orgId_memberId).toEqual({
        orgId: "org-1",
        memberId: "member-1",
      });
    }
  });

  test("output: preserves all compound ID fields", () => {
    const input = {
      orgId_memberId: { orgId: "org-123", memberId: "member-456" },
    };
    const result = parse(schema, input);
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      expect(result.value.orgId_memberId?.orgId).toBe("org-123");
      expect(result.value.orgId_memberId?.memberId).toBe("member-456");
    }
  });

  test("runtime: compound key requires all fields", () => {
    const result = parse(schema, {
      orgId_memberId: { orgId: "org-1" }, // missing memberId
    });
    expect(result.issues).toBeDefined();
  });
});

// =============================================================================
// RUNTIME TESTS - Compound Unique Model
// =============================================================================

describe("Compound Constraint Filter - Compound Unique Model Runtime", () => {
  const schema = compoundUniqueSchemas._filter.compoundConstraint;

  test("runtime: accepts empty object", () => {
    const result = parse(schema, {});
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      expect(result.value).toEqual({});
    }
  });

  test("runtime: accepts compound unique key", () => {
    const result = parse(schema, {
      email_tenantId: { email: "a@b.com", tenantId: "tenant-1" },
    });
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      expect(result.value.email_tenantId).toEqual({
        email: "a@b.com",
        tenantId: "tenant-1",
      });
    }
  });

  test("output: preserves all compound unique fields", () => {
    const input = {
      email_tenantId: { email: "test@example.com", tenantId: "tenant-xyz" },
    };
    const result = parse(schema, input);
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      expect(result.value.email_tenantId?.email).toBe("test@example.com");
      expect(result.value.email_tenantId?.tenantId).toBe("tenant-xyz");
    }
  });

  test("runtime: compound unique requires all fields", () => {
    const result = parse(schema, {
      email_tenantId: { email: "a@b.com" }, // missing tenantId
    });
    expect(result.issues).toBeDefined();
  });
});

// =============================================================================
// RUNTIME TESTS - Simple Model (no compound constraints)
// =============================================================================

describe("Compound Constraint Filter - Simple Model Runtime", () => {
  const schema = simpleSchemas._filter.compoundConstraint;

  test("runtime: accepts empty object", () => {
    const result = parse(schema, {});
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      expect(result.value).toEqual({});
    }
  });

  test("output: returns empty object for model without compound constraints", () => {
    const result = parse(schema, {});
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      expect(Object.keys(result.value)).toHaveLength(0);
    }
  });

  test("runtime: rejects unknown key (strict schema)", () => {
    // Schema is strict to prevent invalid SQL from extra keys
    const result = parse(schema, { anyKey: {} });
    expect(result.issues).toBeDefined();
  });
});
