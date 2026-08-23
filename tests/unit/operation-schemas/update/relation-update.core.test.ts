/**
 * Relation Update Schema Tests
 *
 * Tests the _update.relation schema which includes executable and planned
 * nested write operation shapes for relations.
 */

import {
  authorSchemas,
  postSchemas,
  simpleSchemas,
} from "@tests/unit/operation-schemas/fixtures";
import { type InferInput, parse } from "@validation";
import { describe, expect, expectTypeOf, test } from "vitest";

// =============================================================================
// TYPE TESTS - Author Model (has oneToMany)
// =============================================================================

describe("Relation Update - Types (Author Model)", () => {
  type Input = InferInput<typeof authorSchemas.relationUpdate>;

  test("type: includes relation field", () => {
    expectTypeOf<Input>().toHaveProperty("posts");
  });

  test("type: all relations are optional", () => {
    expectTypeOf<{}>().toMatchTypeOf<Input>();
  });

  test("type: createMany requires data", () => {
    expectTypeOf<{
      posts?: {
        createMany: {};
      };
    }>().not.toMatchTypeOf<Input>();

    expectTypeOf<{
      posts?: {
        createMany: {
          data: Array<{ id: string; title: string; authorId: string }>;
        };
      };
    }>().toMatchTypeOf<Input>();
  });
});

// =============================================================================
// TYPE TESTS - Post Model (has manyToOne)
// =============================================================================

describe("Relation Update - Types (Post Model)", () => {
  type Input = InferInput<typeof postSchemas.relationUpdate>;

  test("type: includes relation field", () => {
    expectTypeOf<Input>().toHaveProperty("author");
  });

  test("type: to-one update accepts planned update and upsert", () => {
    expectTypeOf<{
      author?: {
        update: { name?: string };
      };
    }>().toMatchTypeOf<Input>();
    expectTypeOf<{
      author?: {
        upsert: {
          create: { id: string; name: string };
          update: { name?: string };
        };
      };
    }>().toMatchTypeOf<Input>();
  });

  test("type: to-one update rejects to-many-only planned operations", () => {
    expectTypeOf<{
      author?: {
        updateMany: { data: { name?: string } };
      };
    }>().not.toMatchTypeOf<Input>();
    expectTypeOf<{
      author?: {
        deleteMany: { name?: string };
      };
    }>().not.toMatchTypeOf<Input>();
  });

  test("type: to-one connectOrCreate requires where and create", () => {
    expectTypeOf<{
      author?: {
        connectOrCreate: {};
      };
    }>().not.toMatchTypeOf<Input>();
    expectTypeOf<{
      author?: {
        connectOrCreate: { where: { id: string } };
      };
    }>().not.toMatchTypeOf<Input>();
    expectTypeOf<{
      author?: {
        connectOrCreate: { create: { id: string; name: string } };
      };
    }>().not.toMatchTypeOf<Input>();
  });
});

// =============================================================================
// RUNTIME TESTS - Author Model (oneToMany)
// =============================================================================

describe("Relation Update - Author Model Runtime (oneToMany)", () => {
  const schema = authorSchemas.relationUpdate;

  test("runtime: accepts empty object", () => {
    const result = parse(schema, {});
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts create nested write", () => {
    const result = parse(schema, {
      posts: {
        create: { id: "post-1", title: "Hello" },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts createMany nested write", () => {
    const result = parse(schema, {
      posts: {
        createMany: {
          data: [
            { id: "post-1", title: "Hello" },
            { id: "post-2", title: "World" },
          ],
        },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: rejects createMany nested write without data", () => {
    const result = parse(schema, {
      posts: {
        createMany: {},
      },
    });
    expect(result.issues?.[0]?.message).toBe("Missing required field: data");
    expect(result.issues?.[0]?.path).toEqual(["posts", "createMany", "data"]);
  });

  test("runtime: accepts connect nested write", () => {
    const result = parse(schema, {
      posts: {
        connect: { id: "existing-post-id" },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: rejects disconnect for required relation membership", () => {
    const result = parse(schema, {
      posts: {
        disconnect: { id: "post-to-disconnect" },
      },
    });
    expect(result.issues?.[0]?.message).toBe("Unknown key: disconnect");
    expect(result.issues?.[0]?.path).toEqual(["posts", "disconnect"]);
  });

  test("runtime: accepts delete nested write", () => {
    const result = parse(schema, {
      posts: {
        delete: { id: "post-to-delete" },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts planned to-many update", () => {
    const result = parse(schema, {
      posts: {
        update: {
          where: { id: "post-1" },
          data: { title: "Updated" },
        },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts planned to-many updateMany", () => {
    const result = parse(schema, {
      posts: {
        updateMany: {
          where: { published: false },
          data: { published: true },
        },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts planned to-many upsert", () => {
    const result = parse(schema, {
      posts: {
        upsert: {
          where: { id: "post-1" },
          create: { id: "post-1", title: "Created" },
          update: { title: "Updated" },
        },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts planned to-many deleteMany", () => {
    const result = parse(schema, {
      posts: {
        deleteMany: { published: false },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test.each([
    ["update missing where", { update: { data: { title: "Updated" } } }],
    ["update missing data", { update: { where: { id: "post-1" } } }],
    [
      "updateMany missing data",
      { updateMany: { where: { published: false } } },
    ],
    [
      "upsert missing update",
      {
        upsert: {
          where: { id: "post-1" },
          create: { id: "post-1", title: "Created", authorId: "author-1" },
        },
      },
    ],
  ] as const)(
    "runtime: rejects malformed planned to-many %s",
    (_, envelope) => {
      const result = parse(schema, {
        posts: envelope,
      });
      expect(result.issues).toBeDefined();
    }
  );

  test("runtime: accepts set to replace all", () => {
    const result = parse(schema, {
      posts: {
        set: [{ id: "post-1" }, { id: "post-2" }],
      },
    });
    expect(result.issues).toBeUndefined();
  });
});

// =============================================================================
// RUNTIME TESTS - Post Model (manyToOne)
// =============================================================================

describe("Relation Update - Post Model Runtime (manyToOne)", () => {
  const schema = postSchemas.relationUpdate;

  test("runtime: accepts empty object", () => {
    const result = parse(schema, {});
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts connect nested write", () => {
    const result = parse(schema, {
      author: {
        connect: { id: "author-id" },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test.each([
    ["empty", {}],
    ["missing create", { where: { id: "author-1" } }],
    ["missing where", { create: { id: "author-1", name: "Alice" } }],
  ] as const)("runtime: rejects connectOrCreate envelope %s", (_, envelope) => {
    const result = parse(schema, {
      author: {
        connectOrCreate: envelope,
      },
    });
    expect(result.issues).toBeDefined();
  });

  // RE-PINNED (§9.4): `post.authorId` is not nullable, so this membership
  // cannot be cleared while both rows survive and `disconnect` is absent.
  test("runtime: rejects disconnect on a required membership", () => {
    const result = parse(schema, {
      author: {
        disconnect: true,
      },
    });
    expect(result.issues).toBeDefined();
  });

  test("runtime: accepts planned to-one update", () => {
    const result = parse(schema, {
      author: {
        update: { name: "Updated Author" },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts planned to-one upsert", () => {
    const result = parse(schema, {
      author: {
        upsert: {
          create: { id: "author-1", name: "Alice" },
          update: { name: "Updated Author" },
        },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test.each(["updateMany", "deleteMany"] as const)(
    "runtime: rejects to-many-only '%s' on to-one",
    (operation) => {
      const result = parse(schema, {
        author: {
          [operation]: {},
        },
      });
      expect(result.issues?.[0]?.message).toBe(`Unknown key: ${operation}`);
    }
  );

  test("runtime: accepts create nested write", () => {
    const result = parse(schema, {
      author: {
        create: { id: "new-author", name: "New Author" },
      },
    });
    expect(result.issues).toBeUndefined();
  });
});

// =============================================================================
// RUNTIME TESTS - Simple Model (no relations)
// =============================================================================

describe("Relation Update - Simple Model Runtime (no relations)", () => {
  const schema = simpleSchemas.relationUpdate;

  test("runtime: accepts empty object", () => {
    const result = parse(schema, {});
    expect(result.issues).toBeUndefined();
  });

  test("runtime: rejects unknown relation key (strict schema)", () => {
    // Schema is strict to prevent invalid SQL from extra keys
    const result = parse(schema, { anyRelation: {} });
    expect(result.issues).toBeDefined();
  });
});
