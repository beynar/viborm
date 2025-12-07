/**
 * JSON Field Contract Tests
 *
 * Validates type/runtime parity for JSON fields.
 * Tests: filter, create, update operations.
 */

import { describe, it, expect } from "vitest";
import {
  buildWhereSchema,
  buildCreateSchema,
  buildUpdateSchema,
} from "../../../src/schema/model/runtime/core-schemas.js";
import type {
  ModelWhereInput,
  ModelCreateInput,
  ModelUpdateInput,
} from "../../../src/schema/model/types/index.js";
import { jsonModel, type JsonModelFields } from "../models.js";

const whereSchema = buildWhereSchema(jsonModel);
const createSchema = buildCreateSchema(jsonModel);
const updateSchema = buildUpdateSchema(jsonModel);

// =============================================================================
// FILTER TESTS
// =============================================================================

describe("JSON Filter", () => {
  describe("equals", () => {
    it("accepts object shorthand", () => {
      const input: ModelWhereInput<JsonModelFields> = {
        required: { name: "test", count: 1 },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts explicit equals", () => {
      const input: ModelWhereInput<JsonModelFields> = {
        required: { equals: { name: "test", count: 5 } },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });
  });

  describe("not", () => {
    it("accepts not", () => {
      const input: ModelWhereInput<JsonModelFields> = {
        required: { not: { name: "excluded", count: 0 } },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });
  });

  describe("path operators", () => {
    it("accepts path", () => {
      const input: ModelWhereInput<JsonModelFields> = {
        required: { path: ["name"] },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts string_contains", () => {
      const input: ModelWhereInput<JsonModelFields> = {
        required: { string_contains: "test" },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts string_starts_with", () => {
      const input: ModelWhereInput<JsonModelFields> = {
        required: { string_starts_with: "te" },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts string_ends_with", () => {
      const input: ModelWhereInput<JsonModelFields> = {
        required: { string_ends_with: "st" },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts array_contains", () => {
      const input: ModelWhereInput<JsonModelFields> = {
        required: { array_contains: "item" },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts array_starts_with", () => {
      const input: ModelWhereInput<JsonModelFields> = {
        required: { array_starts_with: "first" },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts array_ends_with", () => {
      const input: ModelWhereInput<JsonModelFields> = {
        required: { array_ends_with: "last" },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });
  });

  describe("nullable field", () => {
    it("accepts null shorthand", () => {
      const input: ModelWhereInput<JsonModelFields> = { nullable: null };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts equals null", () => {
      const input: ModelWhereInput<JsonModelFields> = {
        nullable: { equals: null },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });
  });

  describe("untyped JSON", () => {
    it("accepts any object", () => {
      const input: ModelWhereInput<JsonModelFields> = {
        untyped: { anything: "goes", nested: { deep: true } },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts array", () => {
      const input: ModelWhereInput<JsonModelFields> = {
        untyped: [1, 2, 3],
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("rejects primitive (JSON only accepts objects/arrays)", () => {
      // JSON fields should only accept objects/arrays as filter values, not primitives
      const input = { untyped: "string-value" };
      expect(() => whereSchema.assert(input)).toThrow();
    });
  });
});

// =============================================================================
// CREATE TESTS
// =============================================================================

describe("JSON Create", () => {
  describe("typed JSON field", () => {
    it("accepts matching schema", () => {
      const input: ModelCreateInput<JsonModelFields> = {
        required: { name: "Alice", count: 10 },
        untyped: {},
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });

    it("rejects missing required", () => {
      expect(() => createSchema.assert({ untyped: {} })).toThrow();
    });
  });

  describe("nullable typed JSON", () => {
    it("accepts omitted", () => {
      const input: ModelCreateInput<JsonModelFields> = {
        required: { name: "test", count: 0 },
        untyped: {},
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });

    it("accepts explicit null", () => {
      const input: ModelCreateInput<JsonModelFields> = {
        required: { name: "test", count: 0 },
        nullable: null,
        untyped: {},
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });

    it("accepts value", () => {
      const input: ModelCreateInput<JsonModelFields> = {
        required: { name: "test", count: 0 },
        nullable: { name: "nullable", count: 5 },
        untyped: {},
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });
  });

  describe("field with default", () => {
    it("accepts omitted", () => {
      const input: ModelCreateInput<JsonModelFields> = {
        required: { name: "test", count: 0 },
        untyped: {},
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });

    it("accepts override", () => {
      const input: ModelCreateInput<JsonModelFields> = {
        required: { name: "test", count: 0 },
        withDefault: { name: "custom", count: 100 },
        untyped: {},
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });
  });

  describe("untyped JSON", () => {
    it("accepts any value", () => {
      const input: ModelCreateInput<JsonModelFields> = {
        required: { name: "test", count: 0 },
        untyped: { anything: [1, 2, { nested: true }] },
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });
  });
});

// =============================================================================
// UPDATE TESTS
// =============================================================================

describe("JSON Update", () => {
  describe("direct value", () => {
    it("accepts object", () => {
      const input: ModelUpdateInput<JsonModelFields> = {
        required: { name: "updated", count: 99 },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });

  describe("set operation", () => {
    it("accepts set", () => {
      const input: ModelUpdateInput<JsonModelFields> = {
        required: { set: { name: "new", count: 0 } },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });

  describe("nullable field", () => {
    it("accepts null", () => {
      const input: ModelUpdateInput<JsonModelFields> = { nullable: null };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });

    it("accepts set null", () => {
      const input: ModelUpdateInput<JsonModelFields> = {
        nullable: { set: null },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });

  describe("untyped JSON", () => {
    it("accepts any value", () => {
      const input: ModelUpdateInput<JsonModelFields> = {
        untyped: { completely: "different", structure: [1, 2, 3] },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });

  describe("empty update", () => {
    it("accepts empty object", () => {
      const input: ModelUpdateInput<JsonModelFields> = {};
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });
});

