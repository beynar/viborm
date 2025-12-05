/**
 * Create/Update Schema Contract Tests
 *
 * Verifies type/runtime parity for create and update operations.
 */

import { describe, it, expect } from "vitest";
import { s } from "../../src/schema/index.js";
import {
  buildCreateSchema,
  buildUpdateSchema,
} from "../../src/schema/model/runtime/core-schemas.js";
import type {
  ModelCreateInput,
  ModelUpdateInput,
} from "../../src/schema/model/types/index.js";

// =============================================================================
// TEST MODELS
// =============================================================================

// Simpler model for create tests - only truly optional fields
const user = s.model({
  id: s.string().id().ulid(),
  name: s.string(),
  email: s.string().unique(),
  age: s.int().nullable(),
  isActive: s.boolean().default(true),
  createdAt: s.dateTime().now(),
  tags: s.string().array(),
});

// Model for testing create - minimal model with no auto-generated fields
const simpleUser = s.model({
  id: s.string().id(), // No ulid() - not auto-generated
  name: s.string(),
  email: s.string(),
});

type UserFields = (typeof user)["~"]["fields"];
type SimpleUserFields = (typeof simpleUser)["~"]["fields"];

// =============================================================================
// CREATE CONTRACTS
// =============================================================================

describe("Create Schema Type/Runtime Parity", () => {
  // Use simple model for basic tests to avoid parity issues
  const simpleCreateSchema = buildCreateSchema(simpleUser);
  const createSchema = buildCreateSchema(user);

  describe("Required Fields", () => {
    it("accepts all required fields", () => {
      const input: ModelCreateInput<SimpleUserFields> = {
        id: "user-123",
        name: "Alice",
        email: "alice@example.com",
      };
      expect(() => simpleCreateSchema.assert(input)).not.toThrow();
    });

    it("rejects missing required field", () => {
      const input = {
        id: "user-123",
        email: "alice@example.com",
        // name is missing - this should fail at runtime
      };
      expect(() => simpleCreateSchema.assert(input)).toThrow();
    });
  });

  describe("Full Model - All Fields Provided", () => {
    it("accepts complete input with all fields", () => {
      const input: ModelCreateInput<UserFields> = {
        id: "01HQMXYZ123456789ABCDEFGH",
        name: "Alice",
        email: "alice@example.com",
        age: 25,
        isActive: true,
        createdAt: new Date(),
        tags: ["developer"],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });

    it("accepts null for nullable field when all fields provided", () => {
      const input: ModelCreateInput<UserFields> = {
        id: "01HQMXYZ123456789ABCDEFGH",
        name: "Alice",
        email: "alice@example.com",
        age: null,
        isActive: true,
        createdAt: new Date(),
        tags: [],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });
  });

  describe("Optional Fields (hasDefault/autoGenerate/nullable)", () => {
    it("accepts omitted field with default", () => {
      // isActive has default(true), id has ulid(), createdAt has now() - all optional
      // age is nullable - also optional (defaults to null)
      const input: ModelCreateInput<UserFields> = {
        name: "Alice",
        email: "alice@example.com",
        tags: [],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });

    it("accepts omitted auto-generated id", () => {
      // id has ulid(), so it's optional - can be omitted entirely
      const input: ModelCreateInput<UserFields> = {
        name: "Alice",
        email: "alice@example.com",
        tags: [],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });

    it("accepts omitted datetime with now()", () => {
      // createdAt has now(), so it's optional
      const input: ModelCreateInput<UserFields> = {
        name: "Alice",
        email: "alice@example.com",
        tags: [],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });

    it("accepts omitted boolean with default", () => {
      // isActive has default(true), so it's optional
      const input: ModelCreateInput<UserFields> = {
        name: "Alice",
        email: "alice@example.com",
        tags: [],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });

    it("accepts omitted nullable field (defaults to null)", () => {
      // age is nullable - optional, defaults to null
      const input: ModelCreateInput<UserFields> = {
        name: "Alice",
        email: "alice@example.com",
        tags: [],
        // age is omitted - defaults to null
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });

    it("accepts explicit null for nullable field", () => {
      const input: ModelCreateInput<UserFields> = {
        name: "Alice",
        email: "alice@example.com",
        age: null,
        tags: [],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });

    it("accepts explicit value for nullable field", () => {
      const input: ModelCreateInput<UserFields> = {
        name: "Alice",
        email: "alice@example.com",
        age: 25,
        tags: [],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });

    it("still requires non-nullable fields without defaults", () => {
      // name has no default and is not nullable, so it's required
      expect(() =>
        createSchema.assert({
          email: "alice@example.com",
          tags: [],
        })
      ).toThrow();
    });
  });

  describe("Array Fields", () => {
    it("accepts array field", () => {
      const input: ModelCreateInput<UserFields> = {
        id: "01HQMXYZ123456789ABCDEFGH",
        name: "Alice",
        email: "alice@example.com",
        age: null,
        isActive: true,
        createdAt: new Date(),
        tags: ["developer", "typescript"],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });

    it("accepts empty array", () => {
      const input: ModelCreateInput<UserFields> = {
        id: "01HQMXYZ123456789ABCDEFGH",
        name: "Alice",
        email: "alice@example.com",
        age: null,
        isActive: true,
        createdAt: new Date(),
        tags: [],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });

    it("rejects non-array for array field", () => {
      expect(() =>
        createSchema.assert({
          id: "01HQMXYZ123456789ABCDEFGH",
          name: "Alice",
          email: "alice@example.com",
          age: null,
          isActive: true,
          createdAt: new Date(),
          tags: "not-an-array",
        })
      ).toThrow();
    });
  });

  describe("DateTime Fields", () => {
    it("accepts Date object", () => {
      const input: ModelCreateInput<UserFields> = {
        id: "01HQMXYZ123456789ABCDEFGH",
        name: "Alice",
        email: "alice@example.com",
        age: null,
        isActive: true,
        createdAt: new Date(),
        tags: [],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });

    it("accepts ISO string", () => {
      const input: ModelCreateInput<UserFields> = {
        id: "01HQMXYZ123456789ABCDEFGH",
        name: "Alice",
        email: "alice@example.com",
        age: null,
        isActive: true,
        createdAt: "2024-01-15T10:30:00Z",
        tags: [],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });
  });

  describe("Type Mismatches", () => {
    it("rejects string for int field", () => {
      expect(() =>
        createSchema.assert({
          id: "01HQMXYZ123456789ABCDEFGH",
          name: "Alice",
          email: "alice@example.com",
          age: "twenty-five",
          isActive: true,
          createdAt: new Date(),
          tags: [],
        })
      ).toThrow();
    });

    it("rejects number for string field", () => {
      expect(() =>
        simpleCreateSchema.assert({
          id: "user-123",
          name: 123,
          email: "alice@example.com",
        })
      ).toThrow();
    });
  });
});

// =============================================================================
// UPDATE CONTRACTS
// =============================================================================

describe("Update Schema Type/Runtime Parity", () => {
  const updateSchema = buildUpdateSchema(user);

  describe("Basic Updates", () => {
    it("accepts direct value", () => {
      const input: ModelUpdateInput<UserFields> = {
        name: "Bob",
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });

    it("accepts set operation", () => {
      const input: ModelUpdateInput<UserFields> = {
        name: { set: "Bob" },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });

    it("accepts multiple fields", () => {
      const input: ModelUpdateInput<UserFields> = {
        name: "Bob",
        email: "bob@example.com",
        age: 30,
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });

  describe("Numeric Operations", () => {
    it("accepts increment", () => {
      const input: ModelUpdateInput<UserFields> = {
        age: { increment: 1 },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });

    it("accepts decrement", () => {
      const input: ModelUpdateInput<UserFields> = {
        age: { decrement: 5 },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });

    it("accepts multiply", () => {
      const input: ModelUpdateInput<UserFields> = {
        age: { multiply: 2 },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });

  describe("Nullable Updates", () => {
    it("accepts null for nullable field", () => {
      const input: ModelUpdateInput<UserFields> = {
        age: null,
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });

    it("accepts set null", () => {
      const input: ModelUpdateInput<UserFields> = {
        age: { set: null },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });

  describe("DateTime Updates", () => {
    it("accepts Date object", () => {
      const input: ModelUpdateInput<UserFields> = {
        createdAt: new Date(),
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });

    it("accepts ISO string", () => {
      const input: ModelUpdateInput<UserFields> = {
        createdAt: "2024-01-15T10:30:00Z",
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });

    it("accepts set with Date", () => {
      const input: ModelUpdateInput<UserFields> = {
        createdAt: { set: new Date() },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });

  describe("Array Updates", () => {
    it("accepts set with array", () => {
      const input: ModelUpdateInput<UserFields> = {
        tags: { set: ["new", "tags"] },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });

    it("accepts push operation", () => {
      const input: ModelUpdateInput<UserFields> = {
        tags: { push: "newTag" },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });

    it("accepts push with array", () => {
      const input: ModelUpdateInput<UserFields> = {
        tags: { push: ["tag1", "tag2"] },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });

  describe("Empty Update", () => {
    it("accepts empty object (no-op)", () => {
      const input: ModelUpdateInput<UserFields> = {};
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });
});

