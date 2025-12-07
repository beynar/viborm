/**
 * Many-to-One Relation Contract Tests
 *
 * Validates type/runtime parity for manyToOne relations.
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
  manyToOneSource,
  type ManyToOneSourceFields,
} from "../models.js";

const whereSchema = buildWhereSchema(manyToOneSource);
const createSchema = buildCreateSchema(manyToOneSource);
const updateSchema = buildUpdateSchema(manyToOneSource);

// =============================================================================
// FILTER TESTS
// =============================================================================

describe("ManyToOne Relation Filter", () => {
  describe("is operator", () => {
    it("accepts is with scalar filter", () => {
      const input: ModelWhereInput<ManyToOneSourceFields> = {
        target: { is: { name: "Category" } },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts is with nested operators", () => {
      const input: ModelWhereInput<ManyToOneSourceFields> = {
        target: { is: { name: { contains: "cat", mode: "insensitive" } } },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts is with id filter", () => {
      const input: ModelWhereInput<ManyToOneSourceFields> = {
        target: { is: { id: "target-123" } },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });
  });

  describe("isNot operator", () => {
    it("accepts isNot with scalar filter", () => {
      const input: ModelWhereInput<ManyToOneSourceFields> = {
        target: { isNot: { name: "Spam" } },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts isNot with nested operators", () => {
      const input: ModelWhereInput<ManyToOneSourceFields> = {
        target: { isNot: { name: { startsWith: "X" } } },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });
  });

  describe("combined operators", () => {
    it("accepts is + isNot", () => {
      const input: ModelWhereInput<ManyToOneSourceFields> = {
        target: {
          is: { name: { contains: "good" } },
          isNot: { name: { contains: "bad" } },
        },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });
  });

  describe("combined with scalar filters", () => {
    it("accepts relation + scalar filters", () => {
      const input: ModelWhereInput<ManyToOneSourceFields> = {
        title: { contains: "hello" },
        target: { is: { name: "Tech" } },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts in logical operators", () => {
      const input: ModelWhereInput<ManyToOneSourceFields> = {
        AND: [
          { title: { not: null } },
          { target: { is: { name: { contains: "a" } } } },
        ],
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });
  });
});

// =============================================================================
// CREATE TESTS
// =============================================================================

describe("ManyToOne Relation Create", () => {
  describe("connect", () => {
    it("accepts connect with id", () => {
      const input: ModelCreateInput<ManyToOneSourceFields> = {
        title: "My Item",
        targetId: "target-123",
        target: { connect: { id: "target-123" } },
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });
  });

  describe("create nested", () => {
    it("accepts create with required fields", () => {
      const input: ModelCreateInput<ManyToOneSourceFields> = {
        title: "My Item",
        targetId: "temp-id",
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
      const input: ModelCreateInput<ManyToOneSourceFields> = {
        title: "My Item",
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

describe("ManyToOne Relation Update", () => {
  describe("connect", () => {
    it("accepts connect to change target", () => {
      const input: ModelUpdateInput<ManyToOneSourceFields> = {
        target: { connect: { id: "new-target-id" } },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });

  describe("update nested", () => {
    it("accepts update on related target", () => {
      const input: ModelUpdateInput<ManyToOneSourceFields> = {
        target: { update: { name: "Updated Name" } },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });

    it("accepts update with nested set operation", () => {
      const input: ModelUpdateInput<ManyToOneSourceFields> = {
        target: { update: { name: { set: "New Name" } } },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });

  describe("create nested", () => {
    it("accepts create in update", () => {
      const input: ModelUpdateInput<ManyToOneSourceFields> = {
        target: {
          create: {
            name: "Brand New Target",
          },
        },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });

  describe("upsert", () => {
    it("accepts upsert", () => {
      const input: ModelUpdateInput<ManyToOneSourceFields> = {
        target: {
          upsert: {
            create: { name: "Created Target" },
            update: { name: "Updated Target" },
          },
        },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });

  describe("combined scalar + relation update", () => {
    it("accepts both", () => {
      const input: ModelUpdateInput<ManyToOneSourceFields> = {
        title: "Updated Title",
        target: { update: { name: "Updated Target" } },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });

  describe("empty update", () => {
    it("accepts empty object", () => {
      const input: ModelUpdateInput<ManyToOneSourceFields> = {};
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });
});
