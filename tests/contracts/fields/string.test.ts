/**
 * String Field Contract Tests
 *
 * Validates type/runtime parity for string fields.
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
import { stringModel, type StringModelFields } from "../models.js";

const whereSchema = buildWhereSchema(stringModel);
const createSchema = buildCreateSchema(stringModel);
const updateSchema = buildUpdateSchema(stringModel);

// =============================================================================
// FILTER (WHERE) TESTS
// =============================================================================

describe("String Filter", () => {
  describe("equals", () => {
    it("accepts shorthand value", () => {
      const input: ModelWhereInput<StringModelFields> = { required: "hello" };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts explicit equals", () => {
      const input: ModelWhereInput<StringModelFields> = {
        required: { equals: "hello" },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("rejects number", () => {
      expect(() => whereSchema.assert({ required: 123 })).toThrow();
    });
  });

  describe("not", () => {
    it("accepts not value", () => {
      const input: ModelWhereInput<StringModelFields> = {
        required: { not: "hello" },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts not with nested filter", () => {
      const input: ModelWhereInput<StringModelFields> = {
        required: { not: { contains: "test" } },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });
  });

  describe("in/notIn", () => {
    it("accepts in array", () => {
      const input: ModelWhereInput<StringModelFields> = {
        required: { in: ["a", "b", "c"] },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts notIn array", () => {
      const input: ModelWhereInput<StringModelFields> = {
        required: { notIn: ["x", "y"] },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts empty array", () => {
      const input: ModelWhereInput<StringModelFields> = {
        required: { in: [] },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });
  });

  describe("contains/startsWith/endsWith", () => {
    it("accepts contains", () => {
      const input: ModelWhereInput<StringModelFields> = {
        required: { contains: "ello" },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts startsWith", () => {
      const input: ModelWhereInput<StringModelFields> = {
        required: { startsWith: "he" },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts endsWith", () => {
      const input: ModelWhereInput<StringModelFields> = {
        required: { endsWith: "lo" },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts mode insensitive", () => {
      const input: ModelWhereInput<StringModelFields> = {
        required: { contains: "HELLO", mode: "insensitive" },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });
  });

  describe("lt/lte/gt/gte (lexicographic)", () => {
    it("accepts lt", () => {
      const input: ModelWhereInput<StringModelFields> = {
        required: { lt: "z" },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts gte", () => {
      const input: ModelWhereInput<StringModelFields> = {
        required: { gte: "a" },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });
  });

  describe("nullable field", () => {
    it("accepts null", () => {
      const input: ModelWhereInput<StringModelFields> = { nullable: null };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts equals null", () => {
      const input: ModelWhereInput<StringModelFields> = {
        nullable: { equals: null },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts not null", () => {
      const input: ModelWhereInput<StringModelFields> = {
        nullable: { not: null },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });
  });

  describe("array field", () => {
    it("accepts has", () => {
      const input: ModelWhereInput<StringModelFields> = {
        array: { has: "item" },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts hasEvery", () => {
      const input: ModelWhereInput<StringModelFields> = {
        array: { hasEvery: ["a", "b"] },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts hasSome", () => {
      const input: ModelWhereInput<StringModelFields> = {
        array: { hasSome: ["a", "b"] },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts isEmpty", () => {
      const input: ModelWhereInput<StringModelFields> = {
        array: { isEmpty: true },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts equals array", () => {
      const input: ModelWhereInput<StringModelFields> = {
        array: { equals: ["a", "b"] },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });
  });
});

// =============================================================================
// CREATE TESTS
// =============================================================================

describe("String Create", () => {
  describe("required field", () => {
    it("accepts string value", () => {
      const input: ModelCreateInput<StringModelFields> = {
        required: "hello",
        array: [],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });

    it("rejects missing required", () => {
      expect(() => createSchema.assert({ array: [] })).toThrow();
    });

    it("rejects null for required", () => {
      expect(() =>
        createSchema.assert({ required: null, array: [] })
      ).toThrow();
    });
  });

  describe("nullable field", () => {
    it("accepts omitted (optional)", () => {
      const input: ModelCreateInput<StringModelFields> = {
        required: "hello",
        array: [],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });

    it("accepts explicit null", () => {
      const input: ModelCreateInput<StringModelFields> = {
        required: "hello",
        nullable: null,
        array: [],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });

    it("accepts value", () => {
      const input: ModelCreateInput<StringModelFields> = {
        required: "hello",
        nullable: "world",
        array: [],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });
  });

  describe("field with default", () => {
    it("accepts omitted", () => {
      const input: ModelCreateInput<StringModelFields> = {
        required: "hello",
        array: [],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });

    it("accepts explicit value", () => {
      const input: ModelCreateInput<StringModelFields> = {
        required: "hello",
        withDefault: "custom",
        array: [],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });
  });

  describe("array field", () => {
    it("accepts array", () => {
      const input: ModelCreateInput<StringModelFields> = {
        required: "hello",
        array: ["a", "b"],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });

    it("accepts empty array", () => {
      const input: ModelCreateInput<StringModelFields> = {
        required: "hello",
        array: [],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });

    it("rejects non-array", () => {
      expect(() =>
        createSchema.assert({ required: "hello", array: "not-array" })
      ).toThrow();
    });
  });
});

// =============================================================================
// UPDATE TESTS
// =============================================================================

describe("String Update", () => {
  describe("direct value", () => {
    it("accepts string", () => {
      const input: ModelUpdateInput<StringModelFields> = { required: "new" };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });

    it("rejects number", () => {
      expect(() => updateSchema.assert({ required: 123 })).toThrow();
    });
  });

  describe("set operation", () => {
    it("accepts set", () => {
      const input: ModelUpdateInput<StringModelFields> = {
        required: { set: "new" },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });

  describe("nullable field", () => {
    it("accepts null", () => {
      const input: ModelUpdateInput<StringModelFields> = { nullable: null };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });

    it("accepts set null", () => {
      const input: ModelUpdateInput<StringModelFields> = {
        nullable: { set: null },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });

  describe("array field", () => {
    it("accepts set array", () => {
      const input: ModelUpdateInput<StringModelFields> = {
        array: { set: ["new", "values"] },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });

    it("accepts push single", () => {
      const input: ModelUpdateInput<StringModelFields> = {
        array: { push: "new" },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });

    it("accepts push array", () => {
      const input: ModelUpdateInput<StringModelFields> = {
        array: { push: ["a", "b"] },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });

  describe("empty update", () => {
    it("accepts empty object", () => {
      const input: ModelUpdateInput<StringModelFields> = {};
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });
});
