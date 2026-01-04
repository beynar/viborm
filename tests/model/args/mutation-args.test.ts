/**
 * Mutation Args Schema Tests
 *
 * Tests the args schemas for mutation operations:
 * - create, createMany
 * - update, updateMany
 * - delete, deleteMany
 * - upsert
 */

import { type InferInput, parse } from "@validation";
import { describe, expect, expectTypeOf, test } from "vitest";
import { authorSchemas, simpleSchemas } from "../fixtures";

// =============================================================================
// CREATE ARGS
// =============================================================================

describe("Create Args - Types", () => {
  type Input = InferInput<typeof simpleSchemas.args.create>;

  test("type: has required data", () => {
    expectTypeOf<Input>().toHaveProperty("data");
  });

  test("type: has optional select", () => {
    expectTypeOf<Input>().toHaveProperty("select");
  });

  test("type: has optional include", () => {
    expectTypeOf<Input>().toHaveProperty("include");
  });
});

describe("Create Args - Simple Model Runtime", () => {
  const schema = simpleSchemas.args.create;

  test("runtime: accepts valid data", () => {
    const result = parse(schema, {
      data: {
        id: "user-123",
        name: "Alice",
        email: "alice@example.com",
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts with select", () => {
    const result = parse(schema, {
      data: {
        id: "user-123",
        name: "Alice",
        email: "alice@example.com",
      },
      select: { id: true, name: true },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: rejects missing data", () => {
    const result = parse(schema, {});
    expect(result.issues).toBeDefined();
  });

  test("runtime: rejects missing required field in data", () => {
    const result = parse(schema, {
      data: { id: "user-123" }, // missing name, email
    });
    expect(result.issues).toBeDefined();
  });

  test("output: preserves data correctly (with defaults)", () => {
    const input = {
      data: {
        id: "user-123",
        name: "Alice",
        email: "alice@example.com",
      },
    };
    const result = parse(schema, input);
    console.dir(result, { depth: null });
    const age = schema.entries.data.entries.age;
    const resultAge = parse(age, undefined);
    console.dir(resultAge, { depth: null });
    console.dir(schema.entries.data.entries.age, { depth: null });
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      // Schema injects defaults for optional fields with defaults
      expect(result.value.data.id).toBe("user-123");
      expect(result.value.data.name).toBe("Alice");
      expect(result.value.data.email).toBe("alice@example.com");
      // age has .nullable() so defaults to null, active has .default(true)
      expect(result.value.data.age).toBe(null);
      expect(result.value.data.active).toBe(true);
    }
  });

  test("output: preserves select correctly", () => {
    const result = parse(schema, {
      data: {
        id: "user-123",
        name: "Alice",
        email: "alice@example.com",
      },
      select: { id: true, name: true },
    });
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      expect(result.value.select).toEqual({ id: true, name: true });
    }
  });
});

describe("Create Args - Author Model Runtime (with relations)", () => {
  const schema = authorSchemas.args.create;

  test("runtime: accepts with nested relation create", () => {
    const result = parse(schema, {
      data: {
        id: "author-1",
        name: "Alice",
        posts: {
          create: { id: "post-1", title: "Hello", authorId: "author-1" },
        },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts with include", () => {
    const result = parse(schema, {
      data: {
        id: "author-1",
        name: "Alice",
      },
      include: { posts: true },
    });
    expect(result.issues).toBeUndefined();
  });
});

// =============================================================================
// CREATE MANY ARGS
// =============================================================================

describe("CreateMany Args - Simple Model Runtime", () => {
  const schema = simpleSchemas.args.createMany;

  test("runtime: accepts data array", () => {
    const result = parse(schema, {
      data: [
        { id: "user-1", name: "Alice", email: "alice@example.com" },
        { id: "user-2", name: "Bob", email: "bob@example.com" },
      ],
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts with skipDuplicates", () => {
    const result = parse(schema, {
      data: [{ id: "user-1", name: "Alice", email: "alice@example.com" }],
      skipDuplicates: true,
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: rejects missing data", () => {
    const result = parse(schema, {});
    expect(result.issues).toBeDefined();
  });

  test("output: preserves data array correctly (with defaults)", () => {
    const data = [
      { id: "user-1", name: "Alice", email: "alice@example.com" },
      { id: "user-2", name: "Bob", email: "bob@example.com" },
    ];
    const result = parse(schema, { data });
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      expect(Array.isArray(result.value.data)).toBe(true);
      expect(result.value.data).toHaveLength(2);
      // Schema injects defaults for optional fields with defaults
      expect(result.value.data[0].id).toBe("user-1");
      expect(result.value.data[0].name).toBe("Alice");
      expect(result.value.data[0].active).toBe(true);
      expect(result.value.data[1].id).toBe("user-2");
      expect(result.value.data[1].name).toBe("Bob");
    }
  });

  test("output: preserves skipDuplicates boolean", () => {
    const result = parse(schema, {
      data: [{ id: "user-1", name: "Alice", email: "alice@example.com" }],
      skipDuplicates: true,
    });
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      expect(result.value.skipDuplicates).toBe(true);
    }
  });
});

// =============================================================================
// UPDATE ARGS
// =============================================================================

describe("Update Args - Types", () => {
  type Input = InferInput<typeof simpleSchemas.args.update>;

  test("type: has required where", () => {
    expectTypeOf<Input>().toHaveProperty("where");
  });

  test("type: has required data", () => {
    expectTypeOf<Input>().toHaveProperty("data");
  });
});

describe("Update Args - Simple Model Runtime", () => {
  const schema = simpleSchemas.args.update;

  test("runtime: accepts where and data", () => {
    const result = parse(schema, {
      where: { id: "user-123" },
      data: { name: "Updated Name" },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts with select", () => {
    const result = parse(schema, {
      where: { id: "user-123" },
      data: { name: "Updated Name" },
      select: { id: true, name: true },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: rejects missing where", () => {
    const result = parse(schema, {
      data: { name: "Updated Name" },
    });
    expect(result.issues).toBeDefined();
  });

  test("runtime: rejects missing data", () => {
    const result = parse(schema, {
      where: { id: "user-123" },
    });
    expect(result.issues).toBeDefined();
  });

  test("output: preserves where and data correctly (with normalization)", () => {
    const result = parse(schema, {
      where: { id: "user-123" },
      data: { name: "Updated Name" },
    });
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      expect(result.value.where).toEqual({ id: "user-123" });
      // Update values are normalized to { set: value }
      expect(result.value.data).toEqual({ name: { set: "Updated Name" } });
    }
  });
});

describe("Update Args - Author Model Runtime (with relations)", () => {
  const schema = authorSchemas.args.update;

  test("runtime: accepts with nested relation update", () => {
    const result = parse(schema, {
      where: { id: "author-1" },
      data: {
        name: "Updated Name",
        posts: {
          create: { id: "new-post", title: "New Post", authorId: "author-1" },
        },
      },
    });
    expect(result.issues).toBeUndefined();
  });
});

// =============================================================================
// UPDATE MANY ARGS
// =============================================================================

describe("UpdateMany Args - Simple Model Runtime", () => {
  const schema = simpleSchemas.args.updateMany;

  test("runtime: accepts where and data", () => {
    const result = parse(schema, {
      where: { active: false },
      data: { active: true },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts empty where (update all)", () => {
    const result = parse(schema, {
      where: {},
      data: { active: true },
    });
    expect(result.issues).toBeUndefined();
  });

  test("output: preserves where and data correctly (with normalization)", () => {
    const result = parse(schema, {
      where: { active: false },
      data: { active: true },
    });
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      // Filter values are normalized to { equals: value }
      expect(result.value.where).toEqual({ active: { equals: false } });
      // Update values are normalized to { set: value }
      expect(result.value.data).toEqual({ active: { set: true } });
    }
  });
});

// =============================================================================
// DELETE ARGS
// =============================================================================

describe("Delete Args - Types", () => {
  type Input = InferInput<typeof simpleSchemas.args.delete>;

  test("type: has required where", () => {
    expectTypeOf<Input>().toHaveProperty("where");
  });
});

describe("Delete Args - Simple Model Runtime", () => {
  const schema = simpleSchemas.args.delete;

  test("runtime: accepts where with unique", () => {
    const result = parse(schema, {
      where: { id: "user-123" },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: rejects missing where", () => {
    const result = parse(schema, {});
    expect(result.issues).toBeDefined();
  });

  test("runtime: rejects non-unique field in where (strict schema)", () => {
    // Schema is strict - only unique fields are valid in whereUnique
    const result = parse(schema, {
      where: { name: "Alice" },
    });
    expect(result.issues).toBeDefined();
  });

  test("output: preserves where correctly", () => {
    const result = parse(schema, {
      where: { id: "user-123" },
    });
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      expect(result.value.where).toEqual({ id: "user-123" });
    }
  });
});

// =============================================================================
// DELETE MANY ARGS
// =============================================================================

describe("DeleteMany Args - Simple Model Runtime", () => {
  const schema = simpleSchemas.args.deleteMany;

  test("runtime: accepts with where", () => {
    const result = parse(schema, {
      where: { active: false },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts empty where (delete all)", () => {
    const result = parse(schema, {
      where: {},
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts without where", () => {
    const result = parse(schema, {});
    expect(result.issues).toBeUndefined();
  });

  test("output: preserves where correctly (with normalization)", () => {
    const result = parse(schema, {
      where: { active: false },
    });
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      // Filter values are normalized to { equals: value }
      expect(result.value.where).toEqual({ active: { equals: false } });
    }
  });
});

// =============================================================================
// UPSERT ARGS
// =============================================================================

describe("Upsert Args - Types", () => {
  type Input = InferInput<typeof simpleSchemas.args.upsert>;

  test("type: has required where", () => {
    expectTypeOf<Input>().toHaveProperty("where");
  });

  test("type: has required create", () => {
    expectTypeOf<Input>().toHaveProperty("create");
  });

  test("type: has required update", () => {
    expectTypeOf<Input>().toHaveProperty("update");
  });
});

describe("Upsert Args - Simple Model Runtime", () => {
  const schema = simpleSchemas.args.upsert;

  test("runtime: accepts all required fields", () => {
    const result = parse(schema, {
      where: { id: "user-123" },
      create: {
        id: "user-123",
        name: "Alice",
        email: "alice@example.com",
      },
      update: { name: "Updated Alice" },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts with select", () => {
    const result = parse(schema, {
      where: { id: "user-123" },
      create: {
        id: "user-123",
        name: "Alice",
        email: "alice@example.com",
      },
      update: { name: "Updated Alice" },
      select: { id: true, name: true },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: rejects missing create", () => {
    const result = parse(schema, {
      where: { id: "user-123" },
      update: { name: "Updated Alice" },
    });
    expect(result.issues).toBeDefined();
  });

  test("runtime: rejects missing update", () => {
    const result = parse(schema, {
      where: { id: "user-123" },
      create: {
        id: "user-123",
        name: "Alice",
        email: "alice@example.com",
      },
    });
    expect(result.issues).toBeDefined();
  });

  test("output: preserves all upsert fields correctly (with normalization)", () => {
    const input = {
      where: { id: "user-123" },
      create: {
        id: "user-123",
        name: "Alice",
        email: "alice@example.com",
      },
      update: { name: "Updated Alice" },
    };
    const result = parse(schema, input);
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      expect(result.value.where).toEqual({ id: "user-123" });
      // Create gets defaults injected
      expect(result.value.create.id).toBe("user-123");
      expect(result.value.create.name).toBe("Alice");
      expect(result.value.create.email).toBe("alice@example.com");
      expect(result.value.create.active).toBe(true);
      // Update values are normalized to { set: value }
      expect(result.value.update).toEqual({ name: { set: "Updated Alice" } });
    }
  });
});
