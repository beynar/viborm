/**
 * One-to-One Relation Contract Tests
 *
 * Validates type/runtime parity for oneToOne relations.
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
  oneToOneSource,
  type OneToOneSourceFields,
} from "../models.js";

const whereSchema = buildWhereSchema(oneToOneSource);
const createSchema = buildCreateSchema(oneToOneSource);
const updateSchema = buildUpdateSchema(oneToOneSource);

// =============================================================================
// FILTER TESTS
// =============================================================================

describe("OneToOne Relation Filter", () => {
  describe("is operator", () => {
    it("accepts is with scalar filter", () => {
      const input: ModelWhereInput<OneToOneSourceFields> = {
        target: { is: { name: "Alice" } },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts is with nested operators", () => {
      const input: ModelWhereInput<OneToOneSourceFields> = {
        target: { is: { name: { contains: "ali" } } },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts is with multiple fields", () => {
      const input: ModelWhereInput<OneToOneSourceFields> = {
        target: { is: { name: "Alice", id: "123" } },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });
  });

  describe("isNot operator", () => {
    it("accepts isNot with scalar filter", () => {
      const input: ModelWhereInput<OneToOneSourceFields> = {
        target: { isNot: { name: "Bob" } },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts isNot with nested operators", () => {
      const input: ModelWhereInput<OneToOneSourceFields> = {
        target: { isNot: { name: { startsWith: "X" } } },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });
  });

  describe("combined is/isNot", () => {
    it("accepts both is and isNot", () => {
      const input: ModelWhereInput<OneToOneSourceFields> = {
        target: {
          is: { name: { contains: "a" } },
          isNot: { name: { contains: "z" } },
        },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });
  });

  describe("null check (optional relation)", () => {
    it("accepts is null", () => {
      const input: ModelWhereInput<OneToOneSourceFields> = {
        target: null,
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });
  });

  describe("shorthand form", () => {
    it("accepts shorthand with scalar filter", () => {
      // Shorthand { target: { name: "Alice" } } normalized to { target: { is: { name: "Alice" } } }
      const input: ModelWhereInput<OneToOneSourceFields> = {
        target: { name: "Alice" },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts shorthand with nested operators", () => {
      const input: ModelWhereInput<OneToOneSourceFields> = {
        target: { name: { contains: "test" } },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts shorthand with multiple fields", () => {
      const input: ModelWhereInput<OneToOneSourceFields> = {
        target: { name: "Alice", id: "123" },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });
  });
});

// =============================================================================
// CREATE TESTS
// =============================================================================

describe("OneToOne Relation Create", () => {
  describe("omitted (optional)", () => {
    it("accepts create without relation", () => {
      const input: ModelCreateInput<OneToOneSourceFields> = {
        targetId: "target-123",
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });
  });

  describe("connect", () => {
    it("accepts connect with id", () => {
      const input: ModelCreateInput<OneToOneSourceFields> = {
        targetId: "target-123",
        target: { connect: { id: "target-123" } },
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });
  });

  describe("create nested", () => {
    it("accepts create with required fields", () => {
      const input: ModelCreateInput<OneToOneSourceFields> = {
        targetId: "target-123",
        target: {
          create: {
            name: "New Target",
          },
        },
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });
  });

  describe("connectOrCreate", () => {
    it("accepts connectOrCreate", () => {
      const input: ModelCreateInput<OneToOneSourceFields> = {
        targetId: "target-123",
        target: {
          connectOrCreate: {
            where: { id: "target-123" },
            create: { name: "New Target" },
          },
        },
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });
  });
});

// =============================================================================
// UPDATE TESTS
// =============================================================================

describe("OneToOne Relation Update", () => {
  describe("connect", () => {
    it("accepts connect to change relation", () => {
      const input: ModelUpdateInput<OneToOneSourceFields> = {
        target: { connect: { id: "new-target-id" } },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });

  describe("update nested", () => {
    it("accepts update on related record", () => {
      const input: ModelUpdateInput<OneToOneSourceFields> = {
        target: { update: { name: "Updated Name" } },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });

  describe("upsert", () => {
    it("accepts upsert", () => {
      const input: ModelUpdateInput<OneToOneSourceFields> = {
        target: {
          upsert: {
            create: { name: "Created" },
            update: { name: "Updated" },
          },
        },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });

  describe("disconnect (optional relation)", () => {
    it("accepts disconnect true", () => {
      const input: ModelUpdateInput<OneToOneSourceFields> = {
        target: { disconnect: true },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });

  describe("delete (optional relation)", () => {
    it("accepts delete true", () => {
      const input: ModelUpdateInput<OneToOneSourceFields> = {
        target: { delete: true },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });

  describe("create nested", () => {
    it("accepts create in update", () => {
      const input: ModelUpdateInput<OneToOneSourceFields> = {
        target: {
          create: {
            name: "New Target",
          },
        },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });

  describe("empty update", () => {
    it("accepts empty object", () => {
      const input: ModelUpdateInput<OneToOneSourceFields> = {};
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });
});
