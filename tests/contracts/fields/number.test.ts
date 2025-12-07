/**
 * Number Field Contract Tests (int, float, decimal)
 *
 * Validates type/runtime parity for numeric fields.
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
import {
  intModel,
  floatModel,
  decimalModel,
  type IntModelFields,
  type FloatModelFields,
  type DecimalModelFields,
} from "../models.js";

// =============================================================================
// INT FIELD TESTS
// =============================================================================

describe("Int Field", () => {
  const whereSchema = buildWhereSchema(intModel);
  const createSchema = buildCreateSchema(intModel);
  const updateSchema = buildUpdateSchema(intModel);

  describe("Filter", () => {
    it("accepts shorthand value", () => {
      const input: ModelWhereInput<IntModelFields> = { required: 42 };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts equals", () => {
      const input: ModelWhereInput<IntModelFields> = {
        required: { equals: 42 },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts not", () => {
      const input: ModelWhereInput<IntModelFields> = { required: { not: 0 } };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts in array", () => {
      const input: ModelWhereInput<IntModelFields> = {
        required: { in: [1, 2, 3] },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts notIn array", () => {
      const input: ModelWhereInput<IntModelFields> = {
        required: { notIn: [0] },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts lt", () => {
      const input: ModelWhereInput<IntModelFields> = { required: { lt: 100 } };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts lte", () => {
      const input: ModelWhereInput<IntModelFields> = { required: { lte: 100 } };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts gt", () => {
      const input: ModelWhereInput<IntModelFields> = { required: { gt: 0 } };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts gte", () => {
      const input: ModelWhereInput<IntModelFields> = { required: { gte: 0 } };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts combined operators", () => {
      const input: ModelWhereInput<IntModelFields> = {
        required: { gte: 0, lt: 100 },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("rejects string", () => {
      expect(() => whereSchema.assert({ required: "42" })).toThrow();
    });

    it("accepts null for nullable", () => {
      const input: ModelWhereInput<IntModelFields> = { nullable: null };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts array operators", () => {
      const input: ModelWhereInput<IntModelFields> = {
        array: { has: 5, hasSome: [1, 2] },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });
  });

  describe("Create", () => {
    it("accepts int value", () => {
      const input: ModelCreateInput<IntModelFields> = {
        required: 42,
        array: [],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });

    it("accepts zero", () => {
      const input: ModelCreateInput<IntModelFields> = {
        required: 0,
        array: [],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });

    it("accepts negative", () => {
      const input: ModelCreateInput<IntModelFields> = {
        required: -10,
        array: [],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });

    it("rejects missing required", () => {
      expect(() => createSchema.assert({ array: [] })).toThrow();
    });

    it("accepts omitted nullable", () => {
      const input: ModelCreateInput<IntModelFields> = {
        required: 1,
        array: [],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });

    it("accepts explicit null for nullable", () => {
      const input: ModelCreateInput<IntModelFields> = {
        required: 1,
        nullable: null,
        array: [],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });

    it("accepts omitted field with default", () => {
      const input: ModelCreateInput<IntModelFields> = {
        required: 1,
        array: [],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });

    it("accepts array of ints", () => {
      const input: ModelCreateInput<IntModelFields> = {
        required: 1,
        array: [1, 2, 3],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });
  });

  describe("Update", () => {
    it("accepts direct value", () => {
      const input: ModelUpdateInput<IntModelFields> = { required: 100 };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });

    it("accepts set", () => {
      const input: ModelUpdateInput<IntModelFields> = {
        required: { set: 100 },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });

    it("accepts increment", () => {
      const input: ModelUpdateInput<IntModelFields> = {
        required: { increment: 1 },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });

    it("accepts decrement", () => {
      const input: ModelUpdateInput<IntModelFields> = {
        required: { decrement: 5 },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });

    it("accepts multiply", () => {
      const input: ModelUpdateInput<IntModelFields> = {
        required: { multiply: 2 },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });

    it("accepts divide", () => {
      const input: ModelUpdateInput<IntModelFields> = {
        required: { divide: 2 },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });

    it("accepts null for nullable", () => {
      const input: ModelUpdateInput<IntModelFields> = { nullable: null };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });

    it("accepts array set", () => {
      const input: ModelUpdateInput<IntModelFields> = {
        array: { set: [1, 2, 3] },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });

    it("accepts array push", () => {
      const input: ModelUpdateInput<IntModelFields> = { array: { push: 4 } };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });

    it("accepts empty update", () => {
      const input: ModelUpdateInput<IntModelFields> = {};
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });
});

// =============================================================================
// FLOAT FIELD TESTS
// =============================================================================

describe("Float Field", () => {
  const whereSchema = buildWhereSchema(floatModel);
  const createSchema = buildCreateSchema(floatModel);
  const updateSchema = buildUpdateSchema(floatModel);

  describe("Filter", () => {
    it("accepts float value", () => {
      const input: ModelWhereInput<FloatModelFields> = { required: 3.14 };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts comparison operators", () => {
      const input: ModelWhereInput<FloatModelFields> = {
        required: { gt: 0.0, lte: 100.5 },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });
  });

  describe("Create", () => {
    it("accepts float", () => {
      const input: ModelCreateInput<FloatModelFields> = {
        required: 3.14159,
        array: [],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });

    it("accepts integer (coerced to float)", () => {
      const input: ModelCreateInput<FloatModelFields> = {
        required: 42,
        array: [],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });
  });

  describe("Update", () => {
    it("accepts numeric operations", () => {
      const input: ModelUpdateInput<FloatModelFields> = {
        required: { multiply: 1.5 },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });
});

// =============================================================================
// DECIMAL FIELD TESTS
// =============================================================================

describe("Decimal Field", () => {
  const whereSchema = buildWhereSchema(decimalModel);
  const createSchema = buildCreateSchema(decimalModel);
  const updateSchema = buildUpdateSchema(decimalModel);

  describe("Filter", () => {
    it("accepts decimal value", () => {
      const input: ModelWhereInput<DecimalModelFields> = { required: 99.99 };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts comparison operators", () => {
      const input: ModelWhereInput<DecimalModelFields> = {
        required: { gte: 0, lt: 1000000 },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });
  });

  describe("Create", () => {
    it("accepts decimal", () => {
      const input: ModelCreateInput<DecimalModelFields> = {
        required: 123.45,
        array: [],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });
  });

  describe("Update", () => {
    it("accepts set", () => {
      const input: ModelUpdateInput<DecimalModelFields> = {
        required: { set: 999.99 },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });

    it("accepts increment", () => {
      const input: ModelUpdateInput<DecimalModelFields> = {
        required: { increment: 0.01 },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });
});

