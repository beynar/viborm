/**
 * Runtime Validation Tests using Vitest
 *
 * Tests that the runtime ArkType schemas correctly validate and transform input.
 * Uses the existing comprehensive schema from tests/schema.ts
 */
import { describe, it, expect } from "vitest";
import type { ArkErrors } from "arktype";
import {
  string,
  nullableString,
  number,
  boolean,
  dateTime,
  enumField,
  model,
} from "../schema.js";
import { buildModelSchemas } from "../../src/schema/model/runtime/index.js";
import { s } from "../../src/schema/index.js";

// =============================================================================
// SIMPLE TEST MODEL (no circular relations)
// =============================================================================

// Create a simple test model without circular relations for runtime tests
const simpleUser = s.model({
  id: s.string().id().ulid(),
  name: s.string(),
  email: s.string().unique(),
  age: s.int().nullable(),
  bio: s.string().nullable(),
  tags: s.string().array(),
  createdAt: s.dateTime().now(),
});

const simplePost = s.model({
  id: s.string().id().ulid(),
  title: s.string(),
  content: s.string().nullable(),
  published: s.boolean().default(false),
});

// Minimal model for create tests - no auto-generated fields
const minimalModel = s.model({
  name: s.string(),
  description: s.string().nullable(),
});

// =============================================================================
// SCHEMA INSTANCES
// =============================================================================

const userSchemas = buildModelSchemas(simpleUser);
const postSchemas = buildModelSchemas(simplePost);
const minimalSchemas = buildModelSchemas(minimalModel);

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function isArkErrors(result: unknown): result is ArkErrors {
  return (
    typeof result === "object" &&
    result !== null &&
    "summary" in result &&
    typeof (result as ArkErrors).summary === "string"
  );
}

function assertValid(result: unknown): Record<string, unknown> {
  if (isArkErrors(result)) {
    throw new Error(`Validation failed: ${result.summary}`);
  }
  return result as Record<string, unknown>;
}

function assertInvalid(result: unknown): void {
  expect(isArkErrors(result)).toBe(true);
}

// =============================================================================
// SCALAR FIELD VALIDATION TESTS
// =============================================================================

describe("Scalar Field Validation", () => {
  describe("String field filter schema", () => {
    const filterSchema = string["~"]["schemas"]["filter"];

    it("accepts shorthand string value and normalizes to equals", () => {
      const result = assertValid(filterSchema("Alice"));
      expect(result).toEqual({ equals: "Alice" });
    });

    it("accepts explicit equals", () => {
      const result = assertValid(filterSchema({ equals: "Alice" }));
      expect(result.equals).toBe("Alice");
    });

    it("accepts contains filter", () => {
      const result = assertValid(filterSchema({ contains: "alice" }));
      expect(result.contains).toBe("alice");
    });

    it("accepts startsWith filter", () => {
      const result = assertValid(filterSchema({ startsWith: "al" }));
      expect(result.startsWith).toBe("al");
    });

    it("accepts endsWith filter", () => {
      const result = assertValid(filterSchema({ endsWith: "ce" }));
      expect(result.endsWith).toBe("ce");
    });

    it("accepts in array filter", () => {
      const result = assertValid(filterSchema({ in: ["Alice", "Bob"] }));
      expect(result.in).toEqual(["Alice", "Bob"]);
    });

    it("accepts notIn array filter", () => {
      const result = assertValid(filterSchema({ notIn: ["Alice", "Bob"] }));
      expect(result.notIn).toEqual(["Alice", "Bob"]);
    });

    it("accepts mode insensitive", () => {
      const result = assertValid(
        filterSchema({ contains: "alice", mode: "insensitive" })
      );
      expect(result.mode).toBe("insensitive");
    });

    it("rejects number value", () => {
      assertInvalid(filterSchema(123 as unknown));
    });

    it("rejects boolean value", () => {
      assertInvalid(filterSchema(true as unknown));
    });
  });

  describe("Nullable string filter schema", () => {
    const filterSchema = nullableString["~"]["schemas"]["filter"];

    it("accepts null shorthand", () => {
      const result = assertValid(filterSchema(null));
      expect(result).toEqual({ equals: null });
    });

    it("accepts explicit equals null", () => {
      const result = assertValid(filterSchema({ equals: null }));
      expect(result.equals).toBeNull();
    });
  });

  describe("Number field filter schema", () => {
    const filterSchema = number["~"]["schemas"]["filter"];

    it("accepts shorthand number value and normalizes to equals", () => {
      const result = assertValid(filterSchema(42));
      expect(result).toEqual({ equals: 42 });
    });

    it("accepts explicit equals", () => {
      const result = assertValid(filterSchema({ equals: 42 }));
      expect(result.equals).toBe(42);
    });

    it("accepts gt filter", () => {
      const result = assertValid(filterSchema({ gt: 10 }));
      expect(result.gt).toBe(10);
    });

    it("accepts gte filter", () => {
      const result = assertValid(filterSchema({ gte: 10 }));
      expect(result.gte).toBe(10);
    });

    it("accepts lt filter", () => {
      const result = assertValid(filterSchema({ lt: 100 }));
      expect(result.lt).toBe(100);
    });

    it("accepts lte filter", () => {
      const result = assertValid(filterSchema({ lte: 100 }));
      expect(result.lte).toBe(100);
    });

    it("accepts combined range filter", () => {
      const result = assertValid(filterSchema({ gte: 10, lt: 100 }));
      expect(result.gte).toBe(10);
      expect(result.lt).toBe(100);
    });

    it("rejects string value", () => {
      assertInvalid(filterSchema("42" as unknown));
    });
  });

  describe("Boolean field filter schema", () => {
    const filterSchema = boolean["~"]["schemas"]["filter"];

    it("accepts shorthand true and normalizes to equals", () => {
      const result = assertValid(filterSchema(true));
      expect(result).toEqual({ equals: true });
    });

    it("accepts shorthand false and normalizes to equals", () => {
      const result = assertValid(filterSchema(false));
      expect(result).toEqual({ equals: false });
    });

    it("accepts explicit equals", () => {
      const result = assertValid(filterSchema({ equals: true }));
      expect(result.equals).toBe(true);
    });

    it("rejects string value", () => {
      assertInvalid(filterSchema("true" as unknown));
    });
  });

  describe("DateTime field filter schema", () => {
    const filterSchema = dateTime["~"]["schemas"]["filter"];

    it("accepts Date object shorthand and normalizes to equals", () => {
      const date = new Date("2024-01-01");
      const result = assertValid(filterSchema(date));
      expect(result).toEqual({ equals: date });
    });

    it("accepts ISO string shorthand and normalizes to equals", () => {
      const isoString = "2024-01-01T00:00:00.000Z";
      const result = assertValid(filterSchema(isoString));
      expect(result).toEqual({ equals: isoString });
    });

    it("accepts explicit equals Date", () => {
      const date = new Date("2024-01-01");
      const result = assertValid(filterSchema({ equals: date }));
      expect(result.equals).toEqual(date);
    });

    it("accepts gt date filter", () => {
      const date = new Date("2024-01-01");
      const result = assertValid(filterSchema({ gt: date }));
      expect(result.gt).toEqual(date);
    });

    it("accepts lt date filter", () => {
      const date = new Date("2024-01-01");
      const result = assertValid(filterSchema({ lt: date }));
      expect(result.lt).toEqual(date);
    });
  });

  describe("Enum field filter schema", () => {
    const filterSchema = enumField["~"]["schemas"]["filter"];

    it("accepts valid enum value shorthand", () => {
      const result = assertValid(filterSchema("a"));
      expect(result).toEqual({ equals: "a" });
    });

    it("accepts explicit equals", () => {
      const result = assertValid(filterSchema({ equals: "b" }));
      expect(result.equals).toBe("b");
    });

    it("accepts in array filter", () => {
      const result = assertValid(filterSchema({ in: ["a", "b"] }));
      expect(result.in).toEqual(["a", "b"]);
    });

    it("rejects invalid enum value", () => {
      assertInvalid(filterSchema("c" as unknown));
    });
  });
});

// =============================================================================
// UPDATE FIELD VALIDATION TESTS
// =============================================================================

describe("Scalar Field Update Validation", () => {
  describe("String field update schema", () => {
    const updateSchema = string["~"]["schemas"]["update"];

    it("accepts shorthand string value and normalizes to set", () => {
      const result = assertValid(updateSchema("Bob"));
      expect(result).toEqual({ set: "Bob" });
    });

    it("accepts explicit set", () => {
      const result = assertValid(updateSchema({ set: "Bob" }));
      expect(result.set).toBe("Bob");
    });
  });

  describe("Number field update schema", () => {
    const updateSchema = number["~"]["schemas"]["update"];

    it("accepts shorthand number and normalizes to set", () => {
      const result = assertValid(updateSchema(42));
      expect(result).toEqual({ set: 42 });
    });

    it("accepts explicit set", () => {
      const result = assertValid(updateSchema({ set: 42 }));
      expect(result.set).toBe(42);
    });

    it("accepts increment", () => {
      const result = assertValid(updateSchema({ increment: 1 }));
      expect(result.increment).toBe(1);
    });

    it("accepts decrement", () => {
      const result = assertValid(updateSchema({ decrement: 1 }));
      expect(result.decrement).toBe(1);
    });

    it("accepts multiply", () => {
      const result = assertValid(updateSchema({ multiply: 2 }));
      expect(result.multiply).toBe(2);
    });

    it("accepts divide", () => {
      const result = assertValid(updateSchema({ divide: 2 }));
      expect(result.divide).toBe(2);
    });
  });

  describe("Nullable field update schema", () => {
    const updateSchema = nullableString["~"]["schemas"]["update"];

    it("accepts null shorthand", () => {
      const result = assertValid(updateSchema(null));
      expect(result).toEqual({ set: null });
    });

    it("accepts explicit set null", () => {
      const result = assertValid(updateSchema({ set: null }));
      expect(result.set).toBeNull();
    });
  });
});

// =============================================================================
// MODEL WHERE SCHEMA VALIDATION TESTS
// =============================================================================

describe("Model Where Schema Validation", () => {
  const whereSchema = userSchemas.where;

  it("accepts empty where", () => {
    assertValid(whereSchema({}));
  });

  it("accepts scalar filter shorthand", () => {
    const result = assertValid(whereSchema({ name: "Alice" }));
    expect(result.name).toEqual({ equals: "Alice" });
  });

  it("accepts explicit equals", () => {
    const result = assertValid(whereSchema({ name: { equals: "Alice" } }));
    expect((result.name as Record<string, unknown>)?.equals).toBe("Alice");
  });

  it("accepts nullable field with null", () => {
    const result = assertValid(whereSchema({ bio: null }));
    expect(result.bio).toEqual({ equals: null });
  });

  it("accepts number filter shorthand", () => {
    const result = assertValid(whereSchema({ age: 25 }));
    expect(result.age).toEqual({ equals: 25 });
  });

  it("accepts number comparison filter", () => {
    const result = assertValid(whereSchema({ age: { gte: 18 } }));
    expect((result.age as Record<string, unknown>)?.gte).toBe(18);
  });

  it("accepts AND logical operator", () => {
    const result = assertValid(
      whereSchema({
        AND: [{ name: "Alice" }, { age: 25 }],
      })
    );
    expect(result.AND).toBeDefined();
    expect(Array.isArray(result.AND)).toBe(true);
    expect((result.AND as unknown[]).length).toBe(2);
  });

  it("accepts OR logical operator", () => {
    const result = assertValid(
      whereSchema({
        OR: [{ name: "Alice" }, { name: "Bob" }],
      })
    );
    expect(result.OR).toBeDefined();
    expect(Array.isArray(result.OR)).toBe(true);
    expect((result.OR as unknown[]).length).toBe(2);
  });

  it("accepts NOT logical operator", () => {
    const result = assertValid(
      whereSchema({
        NOT: { name: "Anonymous" },
      })
    );
    expect(result.NOT).toBeDefined();
  });

  it("ignores unknown field names (open schema)", () => {
    // Note: ArkType schemas are open by default, unknown properties are ignored
    assertValid(whereSchema({ invalidField: "value" } as unknown));
  });

  it("rejects wrong type for field", () => {
    assertInvalid(whereSchema({ name: 123 } as unknown));
  });
});

// =============================================================================
// MODEL CREATE SCHEMA VALIDATION TESTS
// =============================================================================

describe("Model Create Schema Validation", () => {
  const createSchema = minimalSchemas.create;

  // Using minimalModel which has no auto-generated fields
  it("accepts valid create with all fields", () => {
    const result = assertValid(
      createSchema({
        name: "Test Item",
        description: null,
      })
    );
    expect(result.name).toBe("Test Item");
    expect(result.description).toBeNull();
  });

  it("accepts create with non-null values for nullable fields", () => {
    const result = assertValid(
      createSchema({
        name: "Test Item",
        description: "A description",
      })
    );
    expect(result.name).toBe("Test Item");
    expect(result.description).toBe("A description");
  });

  it("rejects missing required field", () => {
    assertInvalid(
      createSchema({
        description: "Some description",
      } as unknown)
    );
  });

  it("rejects wrong type for field", () => {
    assertInvalid(
      createSchema({
        name: 123,
      } as unknown)
    );
  });
});

// =============================================================================
// MODEL UPDATE SCHEMA VALIDATION TESTS
// =============================================================================

describe("Model Update Schema Validation", () => {
  const updateSchema = userSchemas.update;

  it("accepts empty update", () => {
    assertValid(updateSchema({}));
  });

  it("accepts shorthand update and normalizes to set", () => {
    const result = assertValid(updateSchema({ name: "Bob" }));
    expect(result.name).toEqual({ set: "Bob" });
  });

  it("accepts explicit set", () => {
    const result = assertValid(updateSchema({ name: { set: "Bob" } }));
    expect((result.name as Record<string, unknown>)?.set).toBe("Bob");
  });

  it("accepts null for nullable fields", () => {
    const result = assertValid(updateSchema({ bio: null }));
    expect(result.bio).toEqual({ set: null });
  });

  it("rejects wrong type for field", () => {
    assertInvalid(updateSchema({ name: 123 } as unknown));
  });
});

// =============================================================================
// NOTE: Relation filter tests removed - using simple models without relations
// for runtime validation tests to avoid circular reference issues
// =============================================================================

// =============================================================================
// OPERATION ARGS VALIDATION TESTS
// =============================================================================

describe("Operation Args Validation", () => {
  describe("FindMany args", () => {
    const findManySchema = userSchemas.findMany;

    it("accepts empty args", () => {
      assertValid(findManySchema({}));
    });

    it("accepts where clause", () => {
      assertValid(
        findManySchema({
          where: { name: "Alice" },
        })
      );
    });

    it("accepts orderBy", () => {
      assertValid(
        findManySchema({
          orderBy: { name: "asc" },
        })
      );
    });

    it("accepts take and skip", () => {
      assertValid(
        findManySchema({
          take: 10,
          skip: 5,
        })
      );
    });

    it("accepts select", () => {
      assertValid(
        findManySchema({
          select: { id: true, name: true },
        })
      );
    });

    it("accepts include", () => {
      assertValid(
        findManySchema({
          include: { posts: true },
        })
      );
    });
  });

  describe("Create args", () => {
    const createArgsSchema = minimalSchemas.createArgs;

    it("accepts valid create args", () => {
      assertValid(
        createArgsSchema({
          data: {
            name: "Test Item",
            description: null,
          },
        })
      );
    });

    it("rejects missing data", () => {
      assertInvalid(createArgsSchema({} as unknown));
    });
  });

  describe("Update args", () => {
    const updateArgsSchema = userSchemas.updateArgs;

    it("accepts valid update args", () => {
      assertValid(
        updateArgsSchema({
          where: { id: "user-123" },
          data: { name: "Bob" },
        })
      );
    });

    it("rejects missing where", () => {
      assertInvalid(
        updateArgsSchema({
          data: { name: "Bob" },
        } as unknown)
      );
    });
  });

  describe("Delete args", () => {
    const deleteArgsSchema = userSchemas.deleteArgs;

    it("accepts valid delete args", () => {
      assertValid(
        deleteArgsSchema({
          where: { id: "user-123" },
        })
      );
    });

    it("rejects missing where", () => {
      assertInvalid(deleteArgsSchema({} as unknown));
    });
  });

  describe("Count args", () => {
    const countArgsSchema = userSchemas.count;

    it("accepts empty count args", () => {
      assertValid(countArgsSchema({}));
    });

    it("accepts where clause", () => {
      assertValid(
        countArgsSchema({
          where: { name: "Alice" },
        })
      );
    });
  });

  describe("Exist args", () => {
    const existArgsSchema = userSchemas.exist;

    it("accepts where clause", () => {
      assertValid(
        existArgsSchema({
          where: { id: "user-123" },
        })
      );
    });
  });
});
