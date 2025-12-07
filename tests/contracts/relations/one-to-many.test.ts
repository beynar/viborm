/**
 * One-to-Many Relation Contract Tests
 *
 * Validates type/runtime parity for oneToMany relations.
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
  oneToManyParent,
  type OneToManyParentFields,
} from "../models.js";

const whereSchema = buildWhereSchema(oneToManyParent);
const createSchema = buildCreateSchema(oneToManyParent);
const updateSchema = buildUpdateSchema(oneToManyParent);

// =============================================================================
// FILTER TESTS
// =============================================================================

describe("OneToMany Relation Filter", () => {
  describe("some operator", () => {
    it("accepts some with scalar filter", () => {
      const input: ModelWhereInput<OneToManyParentFields> = {
        children: { some: { title: "Hello" } },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts some with nested operators", () => {
      const input: ModelWhereInput<OneToManyParentFields> = {
        children: { some: { title: { contains: "world" } } },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts some with multiple fields", () => {
      const input: ModelWhereInput<OneToManyParentFields> = {
        children: { some: { title: "Hello", parentId: "123" } },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });
  });

  describe("every operator", () => {
    it("accepts every with scalar filter", () => {
      const input: ModelWhereInput<OneToManyParentFields> = {
        children: { every: { title: { startsWith: "Draft" } } },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts every with field check", () => {
      const input: ModelWhereInput<OneToManyParentFields> = {
        children: { every: { parentId: { not: null } } },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });
  });

  describe("none operator", () => {
    it("accepts none with scalar filter", () => {
      const input: ModelWhereInput<OneToManyParentFields> = {
        children: { none: { title: "Deleted" } },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts none with nested operators", () => {
      const input: ModelWhereInput<OneToManyParentFields> = {
        children: { none: { title: { contains: "spam" } } },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });
  });

  describe("combined operators", () => {
    it("accepts some + none", () => {
      const input: ModelWhereInput<OneToManyParentFields> = {
        children: {
          some: { title: { contains: "important" } },
          none: { title: { contains: "draft" } },
        },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts all three operators", () => {
      const input: ModelWhereInput<OneToManyParentFields> = {
        children: {
          some: { title: { not: null } },
          every: { parentId: { not: null } },
          none: { title: { startsWith: "DELETED" } },
        },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });
  });

  describe("empty filter", () => {
    it("accepts empty children filter object", () => {
      const input: ModelWhereInput<OneToManyParentFields> = {
        children: {},
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });
  });
});

// =============================================================================
// CREATE TESTS
// =============================================================================

describe("OneToMany Relation Create", () => {
  describe("omitted (optional)", () => {
    it("accepts create without children", () => {
      const input: ModelCreateInput<OneToManyParentFields> = {
        name: "Parent",
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });
  });

  describe("create nested", () => {
    it("accepts create with single item", () => {
      const input: ModelCreateInput<OneToManyParentFields> = {
        name: "Parent",
        children: {
          create: {
            title: "First Child",
            parentId: "parent-123",
          },
        },
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });

    it("accepts create with array", () => {
      const input: ModelCreateInput<OneToManyParentFields> = {
        name: "Parent",
        children: {
          create: [
            { title: "Child 1", parentId: "parent-123" },
            { title: "Child 2", parentId: "parent-123" },
          ],
        },
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });
  });

  describe("connect", () => {
    it("accepts connect with single item", () => {
      const input: ModelCreateInput<OneToManyParentFields> = {
        name: "Parent",
        children: {
          connect: { id: "child-123" },
        },
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });

    it("accepts connect with array", () => {
      const input: ModelCreateInput<OneToManyParentFields> = {
        name: "Parent",
        children: {
          connect: [{ id: "child-1" }, { id: "child-2" }],
        },
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });
  });

  describe("connectOrCreate", () => {
    it("accepts connectOrCreate", () => {
      const input: ModelCreateInput<OneToManyParentFields> = {
        name: "Parent",
        children: {
          connectOrCreate: {
            where: { id: "child-123" },
            create: { title: "New Child", parentId: "parent-123" },
          },
        },
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });

    it("accepts connectOrCreate array", () => {
      const input: ModelCreateInput<OneToManyParentFields> = {
        name: "Parent",
        children: {
          connectOrCreate: [
            {
              where: { id: "child-1" },
              create: { title: "Child 1", parentId: "parent-123" },
            },
            {
              where: { id: "child-2" },
              create: { title: "Child 2", parentId: "parent-123" },
            },
          ],
        },
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });
  });
});

// =============================================================================
// UPDATE TESTS
// =============================================================================

describe("OneToMany Relation Update", () => {
  describe("create nested", () => {
    it("accepts create single", () => {
      const input: ModelUpdateInput<OneToManyParentFields> = {
        children: {
          create: { title: "New Child", parentId: "parent-123" },
        },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });

    it("accepts create array", () => {
      const input: ModelUpdateInput<OneToManyParentFields> = {
        children: {
          create: [
            { title: "Child 1", parentId: "parent-123" },
            { title: "Child 2", parentId: "parent-123" },
          ],
        },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });

  describe("connect", () => {
    it("accepts connect single", () => {
      const input: ModelUpdateInput<OneToManyParentFields> = {
        children: { connect: { id: "child-123" } },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });

    it("accepts connect array", () => {
      const input: ModelUpdateInput<OneToManyParentFields> = {
        children: { connect: [{ id: "child-1" }, { id: "child-2" }] },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });

  describe("disconnect", () => {
    it("accepts disconnect single", () => {
      const input: ModelUpdateInput<OneToManyParentFields> = {
        children: { disconnect: { id: "child-123" } },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });

    it("accepts disconnect array", () => {
      const input: ModelUpdateInput<OneToManyParentFields> = {
        children: { disconnect: [{ id: "child-1" }, { id: "child-2" }] },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });

  describe("delete", () => {
    it("accepts delete single", () => {
      const input: ModelUpdateInput<OneToManyParentFields> = {
        children: { delete: { id: "child-123" } },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });

    it("accepts delete array", () => {
      const input: ModelUpdateInput<OneToManyParentFields> = {
        children: { delete: [{ id: "child-1" }, { id: "child-2" }] },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });

  describe("set", () => {
    it("accepts set to replace all", () => {
      const input: ModelUpdateInput<OneToManyParentFields> = {
        children: { set: [{ id: "only-child" }] },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });

    it("accepts empty set to clear all", () => {
      const input: ModelUpdateInput<OneToManyParentFields> = {
        children: { set: [] },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });

  describe("updateMany", () => {
    it("accepts updateMany (array required)", () => {
      // Note: updateMany requires an array due to ArkType morph/union limitations
      const input: ModelUpdateInput<OneToManyParentFields> = {
        children: {
          updateMany: [
            {
              where: { title: { contains: "draft" } },
              data: { title: "Updated" },
            },
          ],
        },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });

  describe("deleteMany", () => {
    it("accepts deleteMany (array required)", () => {
      // Note: deleteMany requires an array due to ArkType morph/union limitations
      const input: ModelUpdateInput<OneToManyParentFields> = {
        children: {
          deleteMany: [{ title: { contains: "spam" } }],
        },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });

  describe("empty update", () => {
    it("accepts empty object", () => {
      const input: ModelUpdateInput<OneToManyParentFields> = {};
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });
});
