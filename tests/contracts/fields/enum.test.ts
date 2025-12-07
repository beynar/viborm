/**
 * Enum Field Contract Tests
 *
 * Validates type/runtime parity for enum fields.
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
import { enumModel, type EnumModelFields } from "../models.js";

const whereSchema = buildWhereSchema(enumModel);
const createSchema = buildCreateSchema(enumModel);
const updateSchema = buildUpdateSchema(enumModel);

// =============================================================================
// FILTER TESTS
// =============================================================================

describe("Enum Filter", () => {
  describe("equals", () => {
    it("accepts valid enum value shorthand", () => {
      const input: ModelWhereInput<EnumModelFields> = { required: "A" };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts all valid values", () => {
      expect(() => whereSchema.assert({ required: "A" })).not.toThrow();
      expect(() => whereSchema.assert({ required: "B" })).not.toThrow();
      expect(() => whereSchema.assert({ required: "C" })).not.toThrow();
    });

    it("accepts explicit equals", () => {
      const input: ModelWhereInput<EnumModelFields> = {
        required: { equals: "B" },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("rejects invalid enum value", () => {
      expect(() => whereSchema.assert({ required: "INVALID" })).toThrow();
    });

    it("rejects number", () => {
      expect(() => whereSchema.assert({ required: 0 })).toThrow();
    });
  });

  describe("not", () => {
    it("accepts not with valid value", () => {
      const input: ModelWhereInput<EnumModelFields> = {
        required: { not: "A" },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });
  });

  describe("in/notIn", () => {
    it("accepts in array", () => {
      const input: ModelWhereInput<EnumModelFields> = {
        required: { in: ["A", "B"] },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts notIn array", () => {
      const input: ModelWhereInput<EnumModelFields> = {
        required: { notIn: ["C"] },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts empty in array", () => {
      const input: ModelWhereInput<EnumModelFields> = {
        required: { in: [] },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("rejects invalid value in array", () => {
      expect(() =>
        whereSchema.assert({ required: { in: ["A", "INVALID"] } })
      ).toThrow();
    });
  });

  describe("nullable field", () => {
    it("accepts null", () => {
      const input: ModelWhereInput<EnumModelFields> = { nullable: null };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts equals null", () => {
      const input: ModelWhereInput<EnumModelFields> = {
        nullable: { equals: null },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts not null", () => {
      const input: ModelWhereInput<EnumModelFields> = {
        nullable: { not: null },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });
  });

  describe("array field", () => {
    it("accepts has", () => {
      const input: ModelWhereInput<EnumModelFields> = {
        array: { has: "A" },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts hasSome", () => {
      const input: ModelWhereInput<EnumModelFields> = {
        array: { hasSome: ["A", "B"] },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts hasEvery", () => {
      const input: ModelWhereInput<EnumModelFields> = {
        array: { hasEvery: ["A", "B", "C"] },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts isEmpty", () => {
      const input: ModelWhereInput<EnumModelFields> = {
        array: { isEmpty: true },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });
  });
});

// =============================================================================
// CREATE TESTS
// =============================================================================

describe("Enum Create", () => {
  describe("required field", () => {
    it("accepts valid enum value", () => {
      const input: ModelCreateInput<EnumModelFields> = {
        required: "A",
        array: [],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });

    it("rejects missing required", () => {
      expect(() => createSchema.assert({ array: [] })).toThrow();
    });

    it("rejects invalid enum value", () => {
      expect(() =>
        createSchema.assert({ required: "INVALID", array: [] })
      ).toThrow();
    });
  });

  describe("nullable field", () => {
    it("accepts omitted", () => {
      const input: ModelCreateInput<EnumModelFields> = {
        required: "A",
        array: [],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });

    it("accepts explicit null", () => {
      const input: ModelCreateInput<EnumModelFields> = {
        required: "A",
        nullable: null,
        array: [],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });

    it("accepts valid value", () => {
      const input: ModelCreateInput<EnumModelFields> = {
        required: "A",
        nullable: "B",
        array: [],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });
  });

  describe("field with default", () => {
    it("accepts omitted", () => {
      const input: ModelCreateInput<EnumModelFields> = {
        required: "B",
        array: [],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });

    it("accepts override", () => {
      const input: ModelCreateInput<EnumModelFields> = {
        required: "B",
        withDefault: "C",
        array: [],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });
  });

  describe("array field", () => {
    it("accepts array of valid values", () => {
      const input: ModelCreateInput<EnumModelFields> = {
        required: "A",
        array: ["A", "B", "C"],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });

    it("accepts empty array", () => {
      const input: ModelCreateInput<EnumModelFields> = {
        required: "A",
        array: [],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });

    it("rejects array with invalid value", () => {
      expect(() =>
        createSchema.assert({ required: "A", array: ["A", "INVALID"] })
      ).toThrow();
    });
  });
});

// =============================================================================
// UPDATE TESTS
// =============================================================================

describe("Enum Update", () => {
  describe("direct value", () => {
    it("accepts valid value", () => {
      const input: ModelUpdateInput<EnumModelFields> = { required: "B" };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });

    it("rejects invalid value", () => {
      expect(() => updateSchema.assert({ required: "INVALID" })).toThrow();
    });
  });

  describe("set operation", () => {
    it("accepts set with valid value", () => {
      const input: ModelUpdateInput<EnumModelFields> = {
        required: { set: "C" },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });

  describe("nullable field", () => {
    it("accepts null", () => {
      const input: ModelUpdateInput<EnumModelFields> = { nullable: null };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });

    it("accepts set null", () => {
      const input: ModelUpdateInput<EnumModelFields> = {
        nullable: { set: null },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });

  describe("array field", () => {
    it("accepts set array", () => {
      const input: ModelUpdateInput<EnumModelFields> = {
        array: { set: ["A", "B"] },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });

    it("accepts push", () => {
      const input: ModelUpdateInput<EnumModelFields> = {
        array: { push: "C" },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });

  describe("empty update", () => {
    it("accepts empty object", () => {
      const input: ModelUpdateInput<EnumModelFields> = {};
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });
});

