/**
 * Many-to-Many Relation Contract Tests
 *
 * Validates type/runtime parity for manyToMany relations.
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
  manyToManyB,
  type ManyToManyBFields,
} from "../models.js";

const whereSchema = buildWhereSchema(manyToManyB);
const createSchema = buildCreateSchema(manyToManyB);
const updateSchema = buildUpdateSchema(manyToManyB);

// =============================================================================
// FILTER TESTS
// =============================================================================

describe("ManyToMany Relation Filter", () => {
  describe("some operator", () => {
    it("accepts some with scalar filter", () => {
      const input: ModelWhereInput<ManyToManyBFields> = {
        aList: { some: { name: "typescript" } },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts some with nested operators", () => {
      const input: ModelWhereInput<ManyToManyBFields> = {
        aList: { some: { name: { contains: "script" } } },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });
  });

  describe("every operator", () => {
    it("accepts every with scalar filter", () => {
      const input: ModelWhereInput<ManyToManyBFields> = {
        aList: { every: { name: { not: null } } },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });
  });

  describe("none operator", () => {
    it("accepts none with scalar filter", () => {
      const input: ModelWhereInput<ManyToManyBFields> = {
        aList: { none: { name: "spam" } },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });
  });

  describe("combined operators", () => {
    it("accepts some + none", () => {
      const input: ModelWhereInput<ManyToManyBFields> = {
        aList: {
          some: { name: { contains: "good" } },
          none: { name: { contains: "bad" } },
        },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });
  });

  describe("empty filter", () => {
    it("accepts empty aList filter", () => {
      const input: ModelWhereInput<ManyToManyBFields> = {
        aList: {},
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });
  });
});

// =============================================================================
// CREATE TESTS
// =============================================================================

describe("ManyToMany Relation Create", () => {
  describe("omitted (optional)", () => {
    it("accepts create without aList", () => {
      const input: ModelCreateInput<ManyToManyBFields> = {
        title: "My Item",
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });
  });

  describe("connect", () => {
    it("accepts connect single", () => {
      const input: ModelCreateInput<ManyToManyBFields> = {
        title: "My Item",
        aList: {
          connect: { id: "a-123" },
        },
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });

    it("accepts connect array", () => {
      const input: ModelCreateInput<ManyToManyBFields> = {
        title: "My Item",
        aList: {
          connect: [{ id: "a-1" }, { id: "a-2" }],
        },
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });
  });

  describe("create nested", () => {
    it("accepts create single", () => {
      const input: ModelCreateInput<ManyToManyBFields> = {
        title: "My Item",
        aList: {
          create: { name: "New A" },
        },
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });

    it("accepts create array", () => {
      const input: ModelCreateInput<ManyToManyBFields> = {
        title: "My Item",
        aList: {
          create: [{ name: "A 1" }, { name: "A 2" }],
        },
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });
  });

  describe("connectOrCreate", () => {
    it("accepts connectOrCreate single", () => {
      const input: ModelCreateInput<ManyToManyBFields> = {
        title: "My Item",
        aList: {
          connectOrCreate: {
            where: { id: "a-123" },
            create: { name: "New A" },
          },
        },
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });

    it("accepts connectOrCreate array", () => {
      const input: ModelCreateInput<ManyToManyBFields> = {
        title: "My Item",
        aList: {
          connectOrCreate: [
            { where: { id: "a1" }, create: { name: "A 1" } },
            { where: { id: "a2" }, create: { name: "A 2" } },
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

describe("ManyToMany Relation Update", () => {
  describe("connect", () => {
    it("accepts connect single", () => {
      const input: ModelUpdateInput<ManyToManyBFields> = {
        aList: { connect: { id: "new-a" } },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });

    it("accepts connect array", () => {
      const input: ModelUpdateInput<ManyToManyBFields> = {
        aList: { connect: [{ id: "a1" }, { id: "a2" }] },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });

  describe("disconnect", () => {
    it("accepts disconnect single", () => {
      const input: ModelUpdateInput<ManyToManyBFields> = {
        aList: { disconnect: { id: "old-a" } },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });

    it("accepts disconnect array", () => {
      const input: ModelUpdateInput<ManyToManyBFields> = {
        aList: { disconnect: [{ id: "a1" }, { id: "a2" }] },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });

  describe("set", () => {
    it("accepts set to replace all", () => {
      const input: ModelUpdateInput<ManyToManyBFields> = {
        aList: { set: [{ id: "only-a" }] },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });

    it("accepts empty set to clear all", () => {
      const input: ModelUpdateInput<ManyToManyBFields> = {
        aList: { set: [] },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });

  describe("create nested", () => {
    it("accepts create single", () => {
      const input: ModelUpdateInput<ManyToManyBFields> = {
        aList: { create: { name: "New A" } },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });

    it("accepts create array", () => {
      const input: ModelUpdateInput<ManyToManyBFields> = {
        aList: { create: [{ name: "A1" }, { name: "A2" }] },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });

  describe("delete", () => {
    it("accepts delete single", () => {
      const input: ModelUpdateInput<ManyToManyBFields> = {
        aList: { delete: { id: "a1" } },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });

    it("accepts delete array", () => {
      const input: ModelUpdateInput<ManyToManyBFields> = {
        aList: { delete: [{ id: "a1" }, { id: "a2" }] },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });

  describe("updateMany", () => {
    it("accepts updateMany (array required)", () => {
      // Note: updateMany requires an array due to ArkType morph/union limitations
      const input: ModelUpdateInput<ManyToManyBFields> = {
        aList: {
          updateMany: [
            {
              where: { name: { contains: "old" } },
              data: { name: "updated" },
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
      const input: ModelUpdateInput<ManyToManyBFields> = {
        aList: {
          deleteMany: [{ name: { contains: "spam" } }],
        },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });

  describe("empty update", () => {
    it("accepts empty object", () => {
      const input: ModelUpdateInput<ManyToManyBFields> = {};
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });
});
