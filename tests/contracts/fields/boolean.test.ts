/**
 * Boolean Field Contract Tests
 *
 * Validates type/runtime parity for boolean fields.
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
import { booleanModel, type BooleanModelFields } from "../models.js";

const whereSchema = buildWhereSchema(booleanModel);
const createSchema = buildCreateSchema(booleanModel);
const updateSchema = buildUpdateSchema(booleanModel);

// =============================================================================
// FILTER TESTS
// =============================================================================

describe("Boolean Filter", () => {
  describe("equals", () => {
    it("accepts true shorthand", () => {
      const input: ModelWhereInput<BooleanModelFields> = { required: true };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts false shorthand", () => {
      const input: ModelWhereInput<BooleanModelFields> = { required: false };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts explicit equals true", () => {
      const input: ModelWhereInput<BooleanModelFields> = {
        required: { equals: true },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts explicit equals false", () => {
      const input: ModelWhereInput<BooleanModelFields> = {
        required: { equals: false },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("rejects string", () => {
      expect(() => whereSchema.assert({ required: "true" })).toThrow();
    });

    it("rejects number", () => {
      expect(() => whereSchema.assert({ required: 1 })).toThrow();
    });
  });

  describe("not", () => {
    it("accepts not true", () => {
      const input: ModelWhereInput<BooleanModelFields> = {
        required: { not: true },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts not false", () => {
      const input: ModelWhereInput<BooleanModelFields> = {
        required: { not: false },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });
  });

  describe("nullable field", () => {
    it("accepts null", () => {
      const input: ModelWhereInput<BooleanModelFields> = { nullable: null };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts equals null", () => {
      const input: ModelWhereInput<BooleanModelFields> = {
        nullable: { equals: null },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts not null", () => {
      const input: ModelWhereInput<BooleanModelFields> = {
        nullable: { not: null },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });
  });

  describe("array field", () => {
    it("accepts has", () => {
      const input: ModelWhereInput<BooleanModelFields> = {
        array: { has: true },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts isEmpty", () => {
      const input: ModelWhereInput<BooleanModelFields> = {
        array: { isEmpty: true },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });
  });
});

// =============================================================================
// CREATE TESTS
// =============================================================================

describe("Boolean Create", () => {
  describe("required field", () => {
    it("accepts true", () => {
      const input: ModelCreateInput<BooleanModelFields> = {
        required: true,
        array: [],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });

    it("accepts false", () => {
      const input: ModelCreateInput<BooleanModelFields> = {
        required: false,
        array: [],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });

    it("rejects missing required", () => {
      expect(() => createSchema.assert({ array: [] })).toThrow();
    });
  });

  describe("nullable field", () => {
    it("accepts omitted", () => {
      const input: ModelCreateInput<BooleanModelFields> = {
        required: true,
        array: [],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });

    it("accepts explicit null", () => {
      const input: ModelCreateInput<BooleanModelFields> = {
        required: true,
        nullable: null,
        array: [],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });
  });

  describe("field with default", () => {
    it("accepts omitted (uses default)", () => {
      const input: ModelCreateInput<BooleanModelFields> = {
        required: true,
        array: [],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });

    it("accepts explicit override", () => {
      const input: ModelCreateInput<BooleanModelFields> = {
        required: true,
        withDefault: true,
        array: [],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });
  });

  describe("array field", () => {
    it("accepts array of booleans", () => {
      const input: ModelCreateInput<BooleanModelFields> = {
        required: true,
        array: [true, false, true],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });

    it("accepts empty array", () => {
      const input: ModelCreateInput<BooleanModelFields> = {
        required: true,
        array: [],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });
  });
});

// =============================================================================
// UPDATE TESTS
// =============================================================================

describe("Boolean Update", () => {
  describe("direct value", () => {
    it("accepts true", () => {
      const input: ModelUpdateInput<BooleanModelFields> = { required: true };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });

    it("accepts false", () => {
      const input: ModelUpdateInput<BooleanModelFields> = { required: false };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });

  describe("set operation", () => {
    it("accepts set true", () => {
      const input: ModelUpdateInput<BooleanModelFields> = {
        required: { set: true },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });

    it("accepts set false", () => {
      const input: ModelUpdateInput<BooleanModelFields> = {
        required: { set: false },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });

  describe("nullable field", () => {
    it("accepts null", () => {
      const input: ModelUpdateInput<BooleanModelFields> = { nullable: null };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });

    it("accepts set null", () => {
      const input: ModelUpdateInput<BooleanModelFields> = {
        nullable: { set: null },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });

  describe("array field", () => {
    it("accepts set array", () => {
      const input: ModelUpdateInput<BooleanModelFields> = {
        array: { set: [true, false] },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });

    it("accepts push", () => {
      const input: ModelUpdateInput<BooleanModelFields> = {
        array: { push: true },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });

  describe("empty update", () => {
    it("accepts empty object", () => {
      const input: ModelUpdateInput<BooleanModelFields> = {};
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });
});

