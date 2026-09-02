/**
 * Nested Args Schema Tests
 *
 * Tests complex deeply nested argument scenarios:
 * - Deeply nested includes (3+ levels)
 * - Nested creates with relations
 * - Nested updates with multiple operations
 * - Combined nested queries with filters, orderBy, pagination
 */

import { s } from "@schema";
import {
  authorSchemas,
  postSchemas,
} from "@tests/unit/operation-schemas/fixtures";
import { createSchemaRegistry, type InferInput, parse } from "@validation";
import { describe, expect, expectTypeOf, test } from "vitest";

// Test-only view over generated nested selection output unions.
// The runtime assertions below still verify concrete transformed shapes.
type NestedOutput = any;

const nestedOutput = (value: unknown): NestedOutput => value as NestedOutput;

const phase7Author = s.model({
  id: s.string().id(),
  name: s.string(),
  posts: s.toMany(() => phase7Post),
});

const phase7Post = s.model({
  id: s.string().id(),
  title: s.string(),
  published: s.boolean().default(false),
  authorId: s.string(),
  author: s
    .toOne(() => phase7Author)
    .fields("authorId")
    .references("id"),
});

const phase7Schemas = createSchemaRegistry({
  author: phase7Author,
  post: phase7Post,
}).proxy;

const relationScopedAuthor = s.model({
  id: s.string().id(),
  name: s.string(),
  posts: s.toMany(() => relationScopedPost).name("author"),
});

const relationScopedCategory = s.model({
  id: s.string().id(),
  name: s.string(),
  posts: s.toMany(() => relationScopedPost).name("category"),
});

const relationScopedPost = s.model({
  id: s.string().id(),
  title: s.string(),
  authorId: s.string(),
  categoryId: s.string(),
  author: s
    .toOne(() => relationScopedAuthor)
    .fields("authorId")
    .references("id")
    .name("author"),
  category: s
    .toOne(() => relationScopedCategory)
    .fields("categoryId")
    .references("id")
    .name("category"),
});

const relationScopedSchemas = createSchemaRegistry({
  author: relationScopedAuthor,
  category: relationScopedCategory,
  post: relationScopedPost,
}).proxy;

// =============================================================================
// DEEPLY NESTED INCLUDES
// =============================================================================

describe("Deeply Nested Includes", () => {
  describe("Author → Posts → Author (circular)", () => {
    const schema = authorSchemas.args.findUnique;

    test("runtime: accepts 2-level nested include", () => {
      const result = parse(schema, {
        where: { id: "author-1" },
        include: {
          posts: {
            include: {
              author: true,
            },
          },
        },
      });
      expect(result.issues).toBeUndefined();
    });

    test("runtime: accepts 3-level nested include with filters", () => {
      const result = parse(schema, {
        where: { id: "author-1" },
        include: {
          posts: {
            where: { published: true },
            include: {
              author: {
                include: {
                  posts: true,
                },
              },
            },
          },
        },
      });
      expect(result.issues).toBeUndefined();
    });

    test("output: preserves deeply nested include structure", () => {
      const result = parse(schema, {
        where: { id: "author-1" },
        include: {
          posts: {
            where: { published: true },
            take: 5,
            include: {
              author: true,
            },
          },
        },
      });
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(nestedOutput(result.value).include?.posts).toBeDefined();
        expect(nestedOutput(result.value).include?.posts?.take).toBe(5);
        // Boolean `author: true` is transformed to { select: {...} }
        expect(
          nestedOutput(result.value).include?.posts?.include?.author
        ).toHaveProperty("select");
      }
    });
  });

  describe("Post → Author → Posts (reverse circular)", () => {
    const schema = postSchemas.args.findMany;

    test("runtime: accepts nested include with pagination and orderBy", () => {
      const result = parse(schema, {
        where: { published: true },
        include: {
          author: {
            include: {
              posts: {
                take: 10,
                orderBy: { title: "asc" },
              },
            },
          },
        },
        take: 20,
        orderBy: { title: "desc" },
      });

      expect(result.issues).toBeUndefined();
    });

    test("output: preserves nested pagination values", () => {
      const result = parse(schema, {
        include: {
          author: {
            include: {
              posts: {
                take: 5,
                skip: 2,
              },
            },
          },
        },
      });
      expect(result.issues).toBeUndefined();

      if (!result.issues) {
        const nestedPosts = nestedOutput(result.value).include?.author?.include
          ?.posts;
        expect(nestedPosts?.take).toBe(5);
        expect(nestedPosts?.skip).toBe(2);
      }
    });
  });
});

// =============================================================================
// DEEPLY NESTED SELECTS
// =============================================================================

describe("Deeply Nested Selects", () => {
  describe("Author with nested post selection", () => {
    const schema = authorSchemas.args.findUnique;

    test("runtime: accepts nested select within include", () => {
      const result = parse(schema, {
        where: { id: "author-1" },
        include: {
          posts: {
            select: {
              id: true,
              title: true,
              author: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
          },
        },
      });
      expect(result.issues).toBeUndefined();
    });

    test("runtime: accepts top-level select with nested relations", () => {
      const result = parse(schema, {
        where: { id: "author-1" },
        select: {
          id: true,
          name: true,
          posts: {
            select: {
              id: true,
              title: true,
            },
          },
        },
      });
      expect(result.issues).toBeUndefined();
    });

    test("output: preserves nested select structure", () => {
      const result = parse(schema, {
        where: { id: "author-1" },
        select: {
          id: true,
          posts: {
            select: {
              title: true,
            },
          },
        },
      });
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(nestedOutput(result.value).select?.id).toBe(true);
        expect(nestedOutput(result.value).select?.posts?.select?.title).toBe(
          true
        );
      }
    });
  });
});

// =============================================================================
// DEEPLY NESTED CREATES
// =============================================================================

describe("Deeply Nested Creates", () => {
  describe("Author with nested posts creation", () => {
    const schema = authorSchemas.args.create;

    test("runtime: accepts nested create when inverse FK is omitted", () => {
      const result = parse(phase7Schemas.author.args.create, {
        data: {
          id: "author-1",
          name: "Alice",
          posts: {
            create: {
              id: "post-1",
              title: "Hello World",
            },
          },
        },
      });
      expect(result.issues).toBeUndefined();
    });

    test("runtime: accepts nested createMany when inverse FK is omitted", () => {
      const result = parse(phase7Schemas.author.args.create, {
        data: {
          id: "author-1",
          name: "Alice",
          posts: {
            createMany: {
              data: [
                { id: "post-1", title: "First Post" },
                { id: "post-2", title: "Second Post" },
              ],
            },
          },
        },
      });
      expect(result.issues).toBeUndefined();
    });

    test("runtime: rejects nested create missing non-derived required field", () => {
      const result = parse(phase7Schemas.author.args.create, {
        data: {
          id: "author-1",
          name: "Alice",
          posts: {
            create: {
              id: "post-1",
            },
          },
        },
      });
      expect(result.issues).toBeDefined();
    });

    test("runtime: accepts single nested create", () => {
      const result = parse(schema, {
        data: {
          id: "author-1",
          name: "Alice",
          posts: {
            create: {
              id: "post-1",
              title: "Hello World",
            },
          },
        },
      });
      expect(result.issues).toBeUndefined();
    });

    test("runtime: accepts array of nested creates", () => {
      const result = parse(schema, {
        data: {
          id: "author-1",
          name: "Alice",
          posts: {
            create: [
              { id: "post-1", title: "First Post" },
              { id: "post-2", title: "Second Post" },
              { id: "post-3", title: "Third Post" },
            ],
          },
        },
      });
      expect(result.issues).toBeUndefined();
    });

    test("output: normalizes single create to array", () => {
      const result = parse(schema, {
        data: {
          id: "author-1",
          name: "Alice",
          posts: {
            create: {
              id: "post-1",
              title: "Hello",
            },
          },
        },
      });
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // Single object should be normalized to array
        expect(
          Array.isArray(nestedOutput(result.value).data.posts?.create)
        ).toBe(true);
      }
    });

    test("runtime: accepts connectOrCreate with nested data", () => {
      const result = parse(schema, {
        data: {
          id: "author-1",
          name: "Alice",
          posts: {
            connectOrCreate: {
              where: { id: "post-1" },
              create: {
                id: "post-1",
                title: "New Post",
              },
            },
          },
        },
      });
      expect(result.issues).toBeUndefined();
    });

    test.each([
      ["empty", {}],
      ["missing create", { where: { id: "post-1" } }],
      [
        "missing where",
        {
          create: {
            id: "post-1",
            title: "Hello World",
            authorId: "author-1",
          },
        },
      ],
    ] as const)("runtime: rejects nested to-many connectOrCreate envelope %s", (_, envelope) => {
      const result = parse(schema, {
        data: {
          id: "author-1",
          name: "Alice",
          posts: {
            connectOrCreate: envelope,
          },
        },
      });
      expect(result.issues).toBeDefined();
    });

    test("output: normalizes connectOrCreate to array", () => {
      const result = parse(schema, {
        data: {
          id: "author-1",
          name: "Alice",
          posts: {
            connectOrCreate: {
              where: { id: "post-1" },
              create: {
                id: "post-1",
                title: "New Post",
              },
            },
          },
        },
      });
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(
          Array.isArray(nestedOutput(result.value).data.posts?.connectOrCreate)
        ).toBe(true);
      }
    });

    test.each([
      "update",
      "updateMany",
      "upsert",
      "deleteMany",
    ] as const)("runtime: rejects planned update-branch operation '%s' in parent create", (operation) => {
      const result = parse(schema, {
        data: {
          id: "author-1",
          name: "Alice",
          posts: {
            [operation]: {},
          },
        },
      });
      expect(result.issues).toBeDefined();
    });

    // PACKAGE J1 (plan §6 J1) — a root `createMany` row is now the ORDINARY create
    // data shape. This test asserted the opposite ("rejects relation envelopes in
    // top-level createMany"); the four below are what replaced it, covering the same
    // schema seam from both sides.
    test("runtime: a top-level createMany row takes a relation envelope", () => {
      const result = parse(authorSchemas.args.createMany, {
        data: [
          {
            id: "author-1",
            name: "Alice",
            posts: {
              create: { id: "post-1", title: "Post" },
            },
          },
        ],
      });
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // Normalized exactly as the ordinary `create` normalizes it: a single item
        // becomes a one-element list and the nested scalar defaults materialize.
        // `authorId` is NOT among them — the enclosing step derives it, so the
        // nested payload has no key to carry it in (§11.2.21).
        expect(nestedOutput(result.value).data[0].posts.create).toMatchObject([
          {
            id: "post-1",
            title: "Post",
            published: false,
          },
        ]);
      }
    });

    test("runtime: an unknown key BESIDE a real relation key still refuses", () => {
      // The DX rule (AGENTS.md) wants a typo caught, and inside `data` the type
      // checker cannot say so (the measured TS2589 boundary recorded in
      // `tests/types/client/contextual-typing-gate.core.types.ts`). The runtime
      // strict-object refusal is the one that answers, and it must survive the
      // widening — a schema that accepted relations by going non-strict would
      // silently drop the typo.
      const result = parse(authorSchemas.args.createMany, {
        data: [
          {
            id: "author-1",
            name: "Alice",
            posts: { create: { id: "p1", title: "P" } },
            postz: { create: { id: "p2", title: "Q" } },
          },
        ],
      });
      expect(result.issues?.[0]?.message).toBe("Unknown key: postz");
    });

    test("runtime: a createMany row may spell an owned FK as its relation", () => {
      const result = parse(phase7Schemas.post.args.createMany, {
        data: [
          { id: "post-1", title: "Hello", author: { connect: { id: "a1" } } },
        ],
      });
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(nestedOutput(result.value).data[0].author.connect).toEqual({
          id: "a1",
        });
      }
    });

    test("runtime: a createMany row spelling NEITHER the FK nor the relation refuses with the create family's sentence", () => {
      const result = parse(phase7Schemas.post.args.createMany, {
        data: [{ id: "post-1", title: "Hello" }],
      });
      expect(result.issues?.[0]?.message).toBe(
        "Missing required fields: one of authorId or author"
      );
    });
  });

  describe("Post with nested author connectOrCreate", () => {
    const schema = postSchemas.args.create;

    test("runtime: rejects direct create when FK and relation data are omitted", () => {
      const result = parse(phase7Schemas.post.args.create, {
        data: {
          id: "post-1",
          title: "Hello World",
        },
      });
      expect(result.issues).toBeDefined();
    });

    test("runtime: accepts direct create when relation data provides FK", () => {
      const result = parse(phase7Schemas.post.args.create, {
        data: {
          id: "post-1",
          title: "Hello World",
          author: {
            connect: { id: "author-1" },
          },
        },
      });
      expect(result.issues).toBeUndefined();
    });

    test("runtime: accepts nested connectOrCreate on manyToOne", () => {
      const result = parse(schema, {
        data: {
          id: "post-1",
          title: "Hello World",
          authorId: "author-1",
          author: {
            connectOrCreate: {
              where: { id: "author-1" },
              create: {
                id: "author-1",
                name: "Alice",
              },
            },
          },
        },
      });
      expect(result.issues).toBeUndefined();
    });

    test.each([
      ["empty", {}],
      ["missing create", { where: { id: "author-1" } }],
      [
        "missing where",
        {
          create: {
            id: "author-1",
            name: "Alice",
            email: "alice@example.com",
          },
        },
      ],
    ] as const)("runtime: rejects nested to-one connectOrCreate envelope %s", (_, envelope) => {
      const result = parse(schema, {
        data: {
          id: "post-1",
          title: "Hello World",
          authorId: "author-1",
          author: {
            connectOrCreate: envelope,
          },
        },
      });
      expect(result.issues).toBeDefined();
    });
  });
});

// =============================================================================
// DEEPLY NESTED UPDATES
// =============================================================================

describe("Deeply Nested Updates", () => {
  describe("Author with nested post updates", () => {
    const schema = authorSchemas.args.update;
    type UpdateArgsInput = InferInput<typeof schema>;

    test("type: nested update createMany requires data", () => {
      expectTypeOf<{
        where: { id: string };
        data: {
          posts: {
            // biome-ignore lint/complexity/noBannedTypes: the empty object type is the rejected payload under test.
            createMany: {};
          };
        };
      }>().not.toMatchTypeOf<UpdateArgsInput>();

      expectTypeOf<{
        where: { id: string };
        data: {
          posts: {
            createMany: {
              data: Array<{ id: string; title: string; authorId: string }>;
            };
          };
        };
      }>().toMatchTypeOf<UpdateArgsInput>();
    });

    test("type: nested update accepts supported relation mutations", () => {
      expectTypeOf<{
        where: { id: string };
        data: {
          posts: {
            update: { where: { id: string }; data: { title?: string } };
          };
        };
      }>().toMatchTypeOf<UpdateArgsInput>();
      expectTypeOf<{
        where: { id: string };
        data: {
          posts: {
            updateMany: {
              where: { published?: boolean };
              data: { published?: boolean };
            };
          };
        };
      }>().toMatchTypeOf<UpdateArgsInput>();
      expectTypeOf<{
        where: { id: string };
        data: {
          posts: {
            deleteMany: { published?: boolean };
          };
        };
      }>().toMatchTypeOf<UpdateArgsInput>();
      expectTypeOf<{
        where: { id: string };
        data: {
          posts: {
            upsert: {
              where: { id: string };
              create: { id: string; title: string; authorId: string };
              update: { title?: string };
            };
          };
        };
      }>().toMatchTypeOf<UpdateArgsInput>();
    });

    test("runtime: accepts supported nested update operation", () => {
      const result = parse(schema, {
        where: { id: "author-1" },
        data: {
          name: "Updated Alice",
          posts: {
            update: {
              where: { id: "post-1" },
              data: { title: "Updated Title" },
            },
          },
        },
      });
      expect(result.issues).toBeUndefined();
    });

    test("runtime: accepts supported nested update operation arrays", () => {
      const result = parse(schema, {
        where: { id: "author-1" },
        data: {
          posts: {
            update: [
              { where: { id: "post-1" }, data: { title: "Title 1" } },
              { where: { id: "post-2" }, data: { title: "Title 2" } },
            ],
          },
        },
      });
      expect(result.issues).toBeUndefined();
    });

    test("runtime: accepts nested createMany operation", () => {
      const result = parse(schema, {
        where: { id: "author-1" },
        data: {
          posts: {
            createMany: {
              data: [
                { id: "post-1", title: "First" },
                { id: "post-2", title: "Second" },
              ],
              skipDuplicates: true,
            },
          },
        },
      });
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(
          nestedOutput(result.value).data.posts?.createMany?.data
        ).toHaveLength(2);
        expect(
          nestedOutput(result.value).data.posts?.createMany?.skipDuplicates
        ).toBe(true);
      }
    });

    test("runtime: update createMany requires an edge not derived from the parent relation", () => {
      const result = parse(relationScopedSchemas.author.args.update, {
        where: { id: "author-1" },
        data: {
          posts: {
            createMany: {
              data: [{ id: "post-1", title: "Hello" }],
            },
          },
        },
      });
      expect(result.issues?.[0]?.path).toEqual([
        "data",
        "posts",
        "createMany",
        "data",
        0,
      ]);
      expect(result.issues?.[0]?.message).toBe(
        "Missing required fields: one of categoryId or category"
      );
    });

    test("runtime: update createMany accepts FK not derived from parent relation", () => {
      const result = parse(relationScopedSchemas.author.args.update, {
        where: { id: "author-1" },
        data: {
          posts: {
            createMany: {
              data: [
                { id: "post-1", title: "Hello", categoryId: "category-1" },
              ],
            },
          },
        },
      });
      expect(result.issues).toBeUndefined();
    });

    test.each([
      ["empty", {}],
      ["missing create", { where: { id: "post-1" } }],
      [
        "missing where",
        {
          create: {
            id: "post-1",
            title: "Hello",
            authorId: "author-1",
          },
        },
      ],
    ] as const)("runtime: rejects nested update connectOrCreate envelope %s", (_, envelope) => {
      const result = parse(schema, {
        where: { id: "author-1" },
        data: {
          posts: {
            connectOrCreate: envelope,
          },
        },
      });
      expect(result.issues).toBeDefined();
    });

    test("runtime: rejects nested createMany without data", () => {
      const result = parse(schema, {
        where: { id: "author-1" },
        data: {
          posts: {
            createMany: {},
          },
        },
      });
      expect(result.issues?.[0]?.message).toBe("Missing required field: data");
      expect(result.issues?.[0]?.path).toEqual([
        "data",
        "posts",
        "createMany",
        "data",
      ]);
    });

    test("runtime: accepts planned updateMany operation", () => {
      const result = parse(schema, {
        where: { id: "author-1" },
        data: {
          posts: {
            updateMany: {
              where: { published: false },
              data: { published: true },
            },
          },
        },
      });
      expect(result.issues).toBeUndefined();
    });

    test("runtime: accepts planned upsert operation", () => {
      const result = parse(schema, {
        where: { id: "author-1" },
        data: {
          posts: {
            upsert: {
              where: { id: "post-1" },
              create: { id: "post-1", title: "New" },
              update: { title: "Updated" },
            },
          },
        },
      });
      expect(result.issues).toBeUndefined();
    });

    test("runtime: accepts planned deleteMany operation", () => {
      const result = parse(schema, {
        where: { id: "author-1" },
        data: {
          posts: {
            deleteMany: { published: false },
          },
        },
      });
      expect(result.issues).toBeUndefined();
    });

    test("runtime: accepts planned operation in combined nested writes", () => {
      const result = parse(schema, {
        where: { id: "author-1" },
        data: {
          name: "Alice Updated",
          posts: {
            create: { id: "new-post", title: "New" },
            deleteMany: { published: false },
          },
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
        "upsert missing create",
        {
          upsert: {
            where: { id: "post-1" },
            update: { title: "Updated" },
          },
        },
      ],
    ] as const)("runtime: rejects malformed planned operation %s", (_, envelope) => {
      const result = parse(schema, {
        where: { id: "author-1" },
        data: {
          posts: envelope,
        },
      });
      expect(result.issues).toBeDefined();
    });

    test("output: preserves combined operations structure", () => {
      const result = parse(schema, {
        where: { id: "author-1" },
        data: {
          posts: {
            create: { id: "new-post", title: "New" },
            connect: { id: "existing-post" },
            set: { id: "retained-post" },
          },
        },
      });
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(
          Array.isArray(nestedOutput(result.value).data.posts?.create)
        ).toBe(true);
        expect(
          Array.isArray(nestedOutput(result.value).data.posts?.connect)
        ).toBe(true);
        expect(Array.isArray(nestedOutput(result.value).data.posts?.set)).toBe(
          true
        );
      }
    });
  });
});

// =============================================================================
// COMPLEX COMBINED QUERIES
// =============================================================================

describe("Complex Combined Queries", () => {
  describe("findMany with everything", () => {
    const schema = authorSchemas.args.findMany;

    test("runtime: validates nested include args against target model", () => {
      const result = parse(schema, {
        include: {
          posts: {
            where: { title: { contains: "Hello" } },
            orderBy: { title: "asc" },
            select: {
              id: true,
              title: true,
              author: {
                select: { id: true },
              },
            },
          },
        },
      });
      expect(result.issues).toBeUndefined();
    });

    test("runtime: rejects nested include args for non-target fields", () => {
      const result = parse(schema, {
        include: {
          posts: {
            where: { name: "Alice" },
          },
        },
      });
      expect(result.issues).toBeDefined();
    });

    test("runtime: accepts complex findMany with all options", () => {
      const result = parse(schema, {
        where: {
          name: { startsWith: "A" },
          posts: {
            some: { published: true },
          },
        },
        include: {
          posts: {
            where: { published: true },
            orderBy: { title: "desc" },
            take: 5,
            include: {
              author: true,
            },
          },
        },
        orderBy: { name: "asc" },
        take: 20,
        skip: 0,
      });
      expect(result.issues).toBeUndefined();
    });

    test("output: preserves complex nested structure", () => {
      const result = parse(schema, {
        where: { name: { contains: "test" } },
        include: {
          posts: {
            where: { published: true },
            take: 3,
            orderBy: { title: "asc" },
          },
        },
        take: 10,
      });
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(nestedOutput(result.value).take).toBe(10);
        expect(nestedOutput(result.value).include?.posts?.take).toBe(3);
        expect(nestedOutput(result.value).include?.posts?.orderBy).toEqual({
          title: "asc",
        });
      }
    });
  });

  describe("upsert with nested operations", () => {
    const schema = authorSchemas.args.upsert;

    test("runtime: accepts upsert with executable nested writes in both branches", () => {
      const result = parse(schema, {
        where: { id: "author-1" },
        create: {
          id: "author-1",
          name: "Alice",
          posts: {
            create: [
              { id: "post-1", title: "First" },
              { id: "post-2", title: "Second" },
            ],
          },
        },
        update: {
          name: "Alice Updated",
          posts: {
            create: { id: "post-3", title: "Third" },
            set: { id: "post-1" },
          },
        },
      });
      expect(result.issues).toBeUndefined();
    });

    test("runtime: accepts planned nested operation in upsert update branch", () => {
      const result = parse(schema, {
        where: { id: "author-1" },
        create: {
          id: "author-1",
          name: "Alice",
        },
        update: {
          posts: {
            updateMany: {
              where: { published: false },
              data: { published: true },
            },
          },
        },
      });
      expect(result.issues).toBeUndefined();
    });

    test.each([
      "update",
      "updateMany",
      "upsert",
      "deleteMany",
    ] as const)("runtime: rejects planned update-branch operation '%s' in upsert create branch", (operation) => {
      const result = parse(schema, {
        where: { id: "author-1" },
        create: {
          id: "author-1",
          name: "Alice",
          posts: {
            [operation]: {},
          },
        },
        update: {
          name: "Alice Updated",
        },
      });
      expect(result.issues).toBeDefined();
    });

    test("output: preserves upsert nested create arrays", () => {
      const result = parse(schema, {
        where: { id: "author-1" },
        create: {
          id: "author-1",
          name: "Alice",
          posts: {
            create: { id: "post-1", title: "Single" },
          },
        },
        update: {
          posts: {
            create: { id: "post-2", title: "Another" },
          },
        },
      });
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // Both should be normalized to arrays
        expect(
          Array.isArray(nestedOutput(result.value).create.posts?.create)
        ).toBe(true);
        expect(
          Array.isArray(nestedOutput(result.value).update.posts?.create)
        ).toBe(true);
      }
    });
  });
});

// =============================================================================
// RELATION FILTERS IN WHERE
// =============================================================================

describe("Relation Filters in Where", () => {
  describe("Author with post relation filters", () => {
    const schema = authorSchemas.args.findMany;

    test("runtime: accepts some relation filter", () => {
      const result = parse(schema, {
        where: {
          posts: {
            some: { published: true },
          },
        },
      });
      expect(result.issues).toBeUndefined();
    });

    test("runtime: accepts every relation filter", () => {
      const result = parse(schema, {
        where: {
          posts: {
            every: { published: true },
          },
        },
      });
      expect(result.issues).toBeUndefined();
    });

    test("runtime: accepts none relation filter", () => {
      const result = parse(schema, {
        where: {
          posts: {
            none: { published: false },
          },
        },
      });
      expect(result.issues).toBeUndefined();
    });

    test("runtime: accepts nested relation filters", () => {
      const result = parse(schema, {
        where: {
          posts: {
            some: {
              author: {
                is: { name: { startsWith: "A" } },
              },
            },
          },
        },
      });
      expect(result.issues).toBeUndefined();
    });

    test("runtime: accepts combined AND/OR with relation filters", () => {
      const result = parse(schema, {
        where: {
          OR: [
            { posts: { some: { published: true } } },
            { name: { startsWith: "Admin" } },
          ],
          AND: [{ posts: { none: { title: { contains: "draft" } } } }],
        },
      });
      expect(result.issues).toBeUndefined();
    });
  });

  describe("Post with author relation filters", () => {
    const schema = postSchemas.args.findMany;

    test("runtime: accepts manyToOne is filter", () => {
      const result = parse(schema, {
        where: {
          author: {
            is: { name: "Alice" },
          },
        },
      });
      expect(result.issues).toBeUndefined();
    });

    test("runtime: accepts manyToOne isNot filter", () => {
      const result = parse(schema, {
        where: {
          author: {
            isNot: { name: "Bob" },
          },
        },
      });
      expect(result.issues).toBeUndefined();
    });
  });
});
