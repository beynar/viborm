/**
 * BigInt Field Contract Tests
 *
 * Validates type/runtime parity for bigint fields.
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
import { bigintModel, type BigintModelFields } from "../models.js";

const whereSchema = buildWhereSchema(bigintModel);
const createSchema = buildCreateSchema(bigintModel);
const updateSchema = buildUpdateSchema(bigintModel);

// =============================================================================
// FILTER TESTS
// =============================================================================

describe("BigInt Filter", () => {
  describe("equals", () => {
    it("accepts bigint shorthand", () => {
      const input: ModelWhereInput<BigintModelFields> = {
        required: BigInt(9007199254740991),
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts explicit equals", () => {
      const input: ModelWhereInput<BigintModelFields> = {
        required: { equals: BigInt(100) },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts zero", () => {
      const input: ModelWhereInput<BigintModelFields> = {
        required: BigInt(0),
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts negative", () => {
      const input: ModelWhereInput<BigintModelFields> = {
        required: BigInt(-1000),
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });
  });

  describe("not", () => {
    it("accepts not bigint", () => {
      const input: ModelWhereInput<BigintModelFields> = {
        required: { not: BigInt(0) },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });
  });

  describe("in/notIn", () => {
    it("accepts in array", () => {
      const input: ModelWhereInput<BigintModelFields> = {
        required: { in: [BigInt(1), BigInt(2), BigInt(3)] },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts notIn array", () => {
      const input: ModelWhereInput<BigintModelFields> = {
        required: { notIn: [BigInt(0)] },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });
  });

  describe("comparison operators", () => {
    it("accepts lt", () => {
      const input: ModelWhereInput<BigintModelFields> = {
        required: { lt: BigInt(1000000000000) },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts lte", () => {
      const input: ModelWhereInput<BigintModelFields> = {
        required: { lte: BigInt(1000000000000) },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts gt", () => {
      const input: ModelWhereInput<BigintModelFields> = {
        required: { gt: BigInt(0) },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts gte", () => {
      const input: ModelWhereInput<BigintModelFields> = {
        required: { gte: BigInt(0) },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts combined operators", () => {
      const input: ModelWhereInput<BigintModelFields> = {
        required: { gte: BigInt(0), lt: BigInt(1000000000000) },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });
  });

  describe("nullable field", () => {
    it("accepts null", () => {
      const input: ModelWhereInput<BigintModelFields> = { nullable: null };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts equals null", () => {
      const input: ModelWhereInput<BigintModelFields> = {
        nullable: { equals: null },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });
  });

  describe("array field", () => {
    it("accepts has", () => {
      const input: ModelWhereInput<BigintModelFields> = {
        array: { has: BigInt(5) },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts hasSome", () => {
      const input: ModelWhereInput<BigintModelFields> = {
        array: { hasSome: [BigInt(1), BigInt(2)] },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts isEmpty", () => {
      const input: ModelWhereInput<BigintModelFields> = {
        array: { isEmpty: true },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });
  });
});

// =============================================================================
// CREATE TESTS
// =============================================================================

describe("BigInt Create", () => {
  describe("required field", () => {
    it("accepts bigint", () => {
      const input: ModelCreateInput<BigintModelFields> = {
        required: BigInt(9007199254740991),
        array: [],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });

    it("accepts zero", () => {
      const input: ModelCreateInput<BigintModelFields> = {
        required: BigInt(0),
        array: [],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });

    it("accepts large negative", () => {
      const input: ModelCreateInput<BigintModelFields> = {
        required: BigInt(-9007199254740991),
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
      const input: ModelCreateInput<BigintModelFields> = {
        required: BigInt(1),
        array: [],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });

    it("accepts explicit null", () => {
      const input: ModelCreateInput<BigintModelFields> = {
        required: BigInt(1),
        nullable: null,
        array: [],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });
  });

  describe("field with default", () => {
    it("accepts omitted", () => {
      const input: ModelCreateInput<BigintModelFields> = {
        required: BigInt(1),
        array: [],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });
  });

  describe("array field", () => {
    it("accepts array of bigints", () => {
      const input: ModelCreateInput<BigintModelFields> = {
        required: BigInt(1),
        array: [BigInt(1), BigInt(2), BigInt(3)],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });

    it("accepts empty array", () => {
      const input: ModelCreateInput<BigintModelFields> = {
        required: BigInt(1),
        array: [],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });
  });
});

// =============================================================================
// UPDATE TESTS
// =============================================================================

describe("BigInt Update", () => {
  describe("direct value", () => {
    it("accepts bigint", () => {
      const input: ModelUpdateInput<BigintModelFields> = {
        required: BigInt(100),
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });

  describe("set operation", () => {
    it("accepts set", () => {
      const input: ModelUpdateInput<BigintModelFields> = {
        required: { set: BigInt(200) },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });

  describe("nullable field", () => {
    it("accepts null", () => {
      const input: ModelUpdateInput<BigintModelFields> = { nullable: null };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });

    it("accepts set null", () => {
      const input: ModelUpdateInput<BigintModelFields> = {
        nullable: { set: null },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });

  describe("array field", () => {
    it("accepts set array", () => {
      const input: ModelUpdateInput<BigintModelFields> = {
        array: { set: [BigInt(1), BigInt(2)] },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });

    it("accepts push", () => {
      const input: ModelUpdateInput<BigintModelFields> = {
        array: { push: BigInt(3) },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });

  describe("empty update", () => {
    it("accepts empty object", () => {
      const input: ModelUpdateInput<BigintModelFields> = {};
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });
});

