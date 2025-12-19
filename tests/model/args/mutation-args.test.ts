/**
 * Mutation Args Schema Tests
 *
 * Tests the args schemas for mutation operations:
 * - create, createMany
 * - update, updateMany
 * - delete, deleteMany
 * - upsert
 */

import { describe, test, expect, expectTypeOf } from "vitest";
import { parse, safeParse } from "valibot";
import {
  simpleSchemas,
  authorSchemas,
  compoundIdSchemas,
  type SimpleState,
  type AuthorState,
} from "../fixtures";
import type {
  CreateArgsInput,
  CreateManyArgsInput,
  UpdateArgsInput,
  UpdateManyArgsInput,
  DeleteArgsInput,
  DeleteManyArgsInput,
  UpsertArgsInput,
} from "../../../src/schema/model/schemas/args";

// =============================================================================
// CREATE ARGS
// =============================================================================

describe("Create Args - Types", () => {
  type Input = CreateArgsInput<SimpleState>;

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
    const result = safeParse(schema, {
      data: {
        id: "user-123",
        name: "Alice",
        email: "alice@example.com",
      },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts with select", () => {
    const result = safeParse(schema, {
      data: {
        id: "user-123",
        name: "Alice",
        email: "alice@example.com",
      },
      select: { id: true, name: true },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: rejects missing data", () => {
    const result = safeParse(schema, {});
    expect(result.success).toBe(false);
  });

  test("runtime: rejects missing required field in data", () => {
    const result = safeParse(schema, {
      data: { id: "user-123" }, // missing name, email
    });
    expect(result.success).toBe(false);
  });

  test("output: preserves data correctly (with defaults)", () => {
    const input = {
      data: {
        id: "user-123",
        name: "Alice",
        email: "alice@example.com",
      },
    };
    const result = safeParse(schema, input);
    expect(result.success).toBe(true);
    if (result.success) {
      // Schema injects defaults for optional fields with defaults
      expect(result.output.data.id).toBe("user-123");
      expect(result.output.data.name).toBe("Alice");
      expect(result.output.data.email).toBe("alice@example.com");
      // age has .nullable() so defaults to null, active has .default(true)
      expect(result.output.data.age).toBe(null);
      expect(result.output.data.active).toBe(true);
    }
  });

  test("output: preserves select correctly", () => {
    const result = safeParse(schema, {
      data: {
        id: "user-123",
        name: "Alice",
        email: "alice@example.com",
      },
      select: { id: true, name: true },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.select).toEqual({ id: true, name: true });
    }
  });
});

describe("Create Args - Author Model Runtime (with relations)", () => {
  const schema = authorSchemas.args.create;

  test("runtime: accepts with nested relation create", () => {
    const result = safeParse(schema, {
      data: {
        id: "author-1",
        name: "Alice",
        posts: {
          create: { id: "post-1", title: "Hello", authorId: "author-1" },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts with include", () => {
    const result = safeParse(schema, {
      data: {
        id: "author-1",
        name: "Alice",
      },
      include: { posts: true },
    });
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// CREATE MANY ARGS
// =============================================================================

describe("CreateMany Args - Simple Model Runtime", () => {
  const schema = simpleSchemas.args.createMany;

  test("runtime: accepts data array", () => {
    const result = safeParse(schema, {
      data: [
        { id: "user-1", name: "Alice", email: "alice@example.com" },
        { id: "user-2", name: "Bob", email: "bob@example.com" },
      ],
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts with skipDuplicates", () => {
    const result = safeParse(schema, {
      data: [{ id: "user-1", name: "Alice", email: "alice@example.com" }],
      skipDuplicates: true,
    });
    expect(result.success).toBe(true);
  });

  test("runtime: rejects missing data", () => {
    const result = safeParse(schema, {});
    expect(result.success).toBe(false);
  });

  test("output: preserves data array correctly (with defaults)", () => {
    const data = [
      { id: "user-1", name: "Alice", email: "alice@example.com" },
      { id: "user-2", name: "Bob", email: "bob@example.com" },
    ];
    const result = safeParse(schema, { data });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Array.isArray(result.output.data)).toBe(true);
      expect(result.output.data).toHaveLength(2);
      // Schema injects defaults for optional fields with defaults
      expect(result.output.data[0].id).toBe("user-1");
      expect(result.output.data[0].name).toBe("Alice");
      expect(result.output.data[0].active).toBe(true);
      expect(result.output.data[1].id).toBe("user-2");
      expect(result.output.data[1].name).toBe("Bob");
    }
  });

  test("output: preserves skipDuplicates boolean", () => {
    const result = safeParse(schema, {
      data: [{ id: "user-1", name: "Alice", email: "alice@example.com" }],
      skipDuplicates: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.skipDuplicates).toBe(true);
    }
  });
});

// =============================================================================
// UPDATE ARGS
// =============================================================================

describe("Update Args - Types", () => {
  type Input = UpdateArgsInput<SimpleState>;

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
    const result = safeParse(schema, {
      where: { id: "user-123" },
      data: { name: "Updated Name" },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts with select", () => {
    const result = safeParse(schema, {
      where: { id: "user-123" },
      data: { name: "Updated Name" },
      select: { id: true, name: true },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: rejects missing where", () => {
    const result = safeParse(schema, {
      data: { name: "Updated Name" },
    });
    expect(result.success).toBe(false);
  });

  test("runtime: rejects missing data", () => {
    const result = safeParse(schema, {
      where: { id: "user-123" },
    });
    expect(result.success).toBe(false);
  });

  test("output: preserves where and data correctly (with normalization)", () => {
    const result = safeParse(schema, {
      where: { id: "user-123" },
      data: { name: "Updated Name" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.where).toEqual({ id: "user-123" });
      // Update values are normalized to { set: value }
      expect(result.output.data).toEqual({ name: { set: "Updated Name" } });
    }
  });
});

describe("Update Args - Author Model Runtime (with relations)", () => {
  const schema = authorSchemas.args.update;

  test("runtime: accepts with nested relation update", () => {
    const result = safeParse(schema, {
      where: { id: "author-1" },
      data: {
        name: "Updated Name",
        posts: {
          create: { id: "new-post", title: "New Post", authorId: "author-1" },
        },
      },
    });
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// UPDATE MANY ARGS
// =============================================================================

describe("UpdateMany Args - Simple Model Runtime", () => {
  const schema = simpleSchemas.args.updateMany;

  test("runtime: accepts where and data", () => {
    const result = safeParse(schema, {
      where: { active: false },
      data: { active: true },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts empty where (update all)", () => {
    const result = safeParse(schema, {
      where: {},
      data: { active: true },
    });
    expect(result.success).toBe(true);
  });

  test("output: preserves where and data correctly (with normalization)", () => {
    const result = safeParse(schema, {
      where: { active: false },
      data: { active: true },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // Filter values are normalized to { equals: value }
      expect(result.output.where).toEqual({ active: { equals: false } });
      // Update values are normalized to { set: value }
      expect(result.output.data).toEqual({ active: { set: true } });
    }
  });
});

// =============================================================================
// DELETE ARGS
// =============================================================================

describe("Delete Args - Types", () => {
  type Input = DeleteArgsInput<SimpleState>;

  test("type: has required where", () => {
    expectTypeOf<Input>().toHaveProperty("where");
  });
});

describe("Delete Args - Simple Model Runtime", () => {
  const schema = simpleSchemas.args.delete;

  test("runtime: accepts where with unique", () => {
    const result = safeParse(schema, {
      where: { id: "user-123" },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: rejects missing where", () => {
    const result = safeParse(schema, {});
    expect(result.success).toBe(false);
  });

  test("runtime: ignores non-unique field in where (Valibot allows extra keys)", () => {
    // Valibot's partial/object allows extra keys by default
    const result = safeParse(schema, {
      where: { name: "Alice" },
    });
    expect(result.success).toBe(true);
  });

  test("output: preserves where correctly", () => {
    const result = safeParse(schema, {
      where: { id: "user-123" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.where).toEqual({ id: "user-123" });
    }
  });
});

// =============================================================================
// DELETE MANY ARGS
// =============================================================================

describe("DeleteMany Args - Simple Model Runtime", () => {
  const schema = simpleSchemas.args.deleteMany;

  test("runtime: accepts with where", () => {
    const result = safeParse(schema, {
      where: { active: false },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts empty where (delete all)", () => {
    const result = safeParse(schema, {
      where: {},
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts without where", () => {
    const result = safeParse(schema, {});
    expect(result.success).toBe(true);
  });

  test("output: preserves where correctly (with normalization)", () => {
    const result = safeParse(schema, {
      where: { active: false },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // Filter values are normalized to { equals: value }
      expect(result.output.where).toEqual({ active: { equals: false } });
    }
  });
});

// =============================================================================
// UPSERT ARGS
// =============================================================================

describe("Upsert Args - Types", () => {
  type Input = UpsertArgsInput<SimpleState>;

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
    const result = safeParse(schema, {
      where: { id: "user-123" },
      create: {
        id: "user-123",
        name: "Alice",
        email: "alice@example.com",
      },
      update: { name: "Updated Alice" },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts with select", () => {
    const result = safeParse(schema, {
      where: { id: "user-123" },
      create: {
        id: "user-123",
        name: "Alice",
        email: "alice@example.com",
      },
      update: { name: "Updated Alice" },
      select: { id: true, name: true },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: rejects missing create", () => {
    const result = safeParse(schema, {
      where: { id: "user-123" },
      update: { name: "Updated Alice" },
    });
    expect(result.success).toBe(false);
  });

  test("runtime: rejects missing update", () => {
    const result = safeParse(schema, {
      where: { id: "user-123" },
      create: {
        id: "user-123",
        name: "Alice",
        email: "alice@example.com",
      },
    });
    expect(result.success).toBe(false);
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
    const result = safeParse(schema, input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.where).toEqual({ id: "user-123" });
      // Create gets defaults injected
      expect(result.output.create.id).toBe("user-123");
      expect(result.output.create.name).toBe("Alice");
      expect(result.output.create.email).toBe("alice@example.com");
      expect(result.output.create.active).toBe(true);
      // Update values are normalized to { set: value }
      expect(result.output.update).toEqual({ name: { set: "Updated Alice" } });
    }
  });
});

