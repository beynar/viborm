/**
 * Nested Args Schema Tests
 *
 * Tests complex deeply nested argument scenarios:
 * - Deeply nested includes (3+ levels)
 * - Nested creates with relations
 * - Nested updates with multiple operations
 * - Combined nested queries with filters, orderBy, pagination
 */

import { describe, test, expect } from "vitest";
import { safeParse } from "valibot";
import { authorSchemas, postSchemas } from "../fixtures";

// =============================================================================
// DEEPLY NESTED INCLUDES
// =============================================================================

describe("Deeply Nested Includes", () => {
  describe("Author → Posts → Author (circular)", () => {
    const schema = authorSchemas.args.findUnique;

    test("runtime: accepts 2-level nested include", () => {
      const result = safeParse(schema, {
        where: { id: "author-1" },
        include: {
          posts: {
            include: {
              author: true,
            },
          },
        },
      });
      expect(result.success).toBe(true);
    });

    test("runtime: accepts 3-level nested include with filters", () => {
      const result = safeParse(schema, {
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
      expect(result.success).toBe(true);
    });

    test("output: preserves deeply nested include structure", () => {
      const result = safeParse(schema, {
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
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output.include?.posts).toBeDefined();
        expect(result.output.include?.posts?.take).toBe(5);
        // Boolean `author: true` is transformed to { select: {...} }
        expect(result.output.include?.posts?.include?.author).toHaveProperty(
          "select"
        );
      }
    });
  });

  describe("Post → Author → Posts (reverse circular)", () => {
    const schema = postSchemas.args.findMany;

    test("runtime: accepts nested include with pagination and orderBy", () => {
      const result = safeParse(schema, {
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
      console.dir(result, { depth: null });
      expect(result.success).toBe(true);
    });

    test("output: preserves nested pagination values", () => {
      const result = safeParse(schema, {
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
      expect(result.success).toBe(true);
      console.dir(result, { depth: null });
      if (result.success) {
        const nestedPosts = result.output.include?.author?.include?.posts;
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
      const result = safeParse(schema, {
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
      expect(result.success).toBe(true);
    });

    test("runtime: accepts top-level select with nested relations", () => {
      const result = safeParse(schema, {
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
      expect(result.success).toBe(true);
    });

    test("output: preserves nested select structure", () => {
      const result = safeParse(schema, {
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
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output.select?.id).toBe(true);
        expect(result.output.select?.posts?.select?.title).toBe(true);
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

    test("runtime: accepts single nested create", () => {
      const result = safeParse(schema, {
        data: {
          id: "author-1",
          name: "Alice",
          posts: {
            create: {
              id: "post-1",
              title: "Hello World",
              authorId: "author-1",
            },
          },
        },
      });
      expect(result.success).toBe(true);
    });

    test("runtime: accepts array of nested creates", () => {
      const result = safeParse(schema, {
        data: {
          id: "author-1",
          name: "Alice",
          posts: {
            create: [
              { id: "post-1", title: "First Post", authorId: "author-1" },
              { id: "post-2", title: "Second Post", authorId: "author-1" },
              { id: "post-3", title: "Third Post", authorId: "author-1" },
            ],
          },
        },
      });
      expect(result.success).toBe(true);
    });

    test("output: normalizes single create to array", () => {
      const result = safeParse(schema, {
        data: {
          id: "author-1",
          name: "Alice",
          posts: {
            create: {
              id: "post-1",
              title: "Hello",
              authorId: "author-1",
            },
          },
        },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        // Single object should be normalized to array
        expect(Array.isArray(result.output.data.posts?.create)).toBe(true);
      }
    });

    test("runtime: accepts connectOrCreate with nested data", () => {
      const result = safeParse(schema, {
        data: {
          id: "author-1",
          name: "Alice",
          posts: {
            connectOrCreate: {
              where: { id: "post-1" },
              create: {
                id: "post-1",
                title: "New Post",
                authorId: "author-1",
              },
            },
          },
        },
      });
      expect(result.success).toBe(true);
    });

    test("output: normalizes connectOrCreate to array", () => {
      const result = safeParse(schema, {
        data: {
          id: "author-1",
          name: "Alice",
          posts: {
            connectOrCreate: {
              where: { id: "post-1" },
              create: {
                id: "post-1",
                title: "New Post",
                authorId: "author-1",
              },
            },
          },
        },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(Array.isArray(result.output.data.posts?.connectOrCreate)).toBe(
          true
        );
      }
    });
  });

  describe("Post with nested author connectOrCreate", () => {
    const schema = postSchemas.args.create;

    test("runtime: accepts nested connectOrCreate on manyToOne", () => {
      const result = safeParse(schema, {
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
      expect(result.success).toBe(true);
    });
  });
});

// =============================================================================
// DEEPLY NESTED UPDATES
// =============================================================================

describe("Deeply Nested Updates", () => {
  describe("Author with nested post updates", () => {
    const schema = authorSchemas.args.update;

    test("runtime: accepts nested update operation", () => {
      const result = safeParse(schema, {
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
      expect(result.success).toBe(true);
    });

    test("runtime: accepts multiple nested update operations", () => {
      const result = safeParse(schema, {
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
      expect(result.success).toBe(true);
    });

    test("output: normalizes single update to array", () => {
      const result = safeParse(schema, {
        where: { id: "author-1" },
        data: {
          posts: {
            update: {
              where: { id: "post-1" },
              data: { title: "Updated" },
            },
          },
        },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(Array.isArray(result.output.data.posts?.update)).toBe(true);
      }
    });

    test("runtime: accepts updateMany with filter", () => {
      const result = safeParse(schema, {
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
      expect(result.success).toBe(true);
    });

    test("output: normalizes updateMany to array", () => {
      const result = safeParse(schema, {
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
      expect(result.success).toBe(true);
      if (result.success) {
        expect(Array.isArray(result.output.data.posts?.updateMany)).toBe(true);
      }
    });

    test("runtime: accepts upsert operation", () => {
      const result = safeParse(schema, {
        where: { id: "author-1" },
        data: {
          posts: {
            upsert: {
              where: { id: "post-1" },
              create: { id: "post-1", title: "New Post", authorId: "author-1" },
              update: { title: "Updated Post" },
            },
          },
        },
      });
      expect(result.success).toBe(true);
    });

    test("output: normalizes upsert to array", () => {
      const result = safeParse(schema, {
        where: { id: "author-1" },
        data: {
          posts: {
            upsert: {
              where: { id: "post-1" },
              create: { id: "post-1", title: "New", authorId: "author-1" },
              update: { title: "Updated" },
            },
          },
        },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(Array.isArray(result.output.data.posts?.upsert)).toBe(true);
      }
    });

    test("runtime: accepts deleteMany operation", () => {
      const result = safeParse(schema, {
        where: { id: "author-1" },
        data: {
          posts: {
            deleteMany: { published: false },
          },
        },
      });
      expect(result.success).toBe(true);
    });

    test("output: normalizes deleteMany to array", () => {
      const result = safeParse(schema, {
        where: { id: "author-1" },
        data: {
          posts: {
            deleteMany: { published: false },
          },
        },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(Array.isArray(result.output.data.posts?.deleteMany)).toBe(true);
      }
    });

    test("runtime: accepts combined nested operations", () => {
      const result = safeParse(schema, {
        where: { id: "author-1" },
        data: {
          name: "Alice Updated",
          posts: {
            create: { id: "new-post", title: "New", authorId: "author-1" },
            update: { where: { id: "post-1" }, data: { title: "Updated" } },
            deleteMany: { published: false },
          },
        },
      });
      expect(result.success).toBe(true);
    });

    test("output: preserves combined operations structure", () => {
      const result = safeParse(schema, {
        where: { id: "author-1" },
        data: {
          posts: {
            create: { id: "new-post", title: "New", authorId: "author-1" },
            connect: { id: "existing-post" },
            disconnect: { id: "old-post" },
          },
        },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(Array.isArray(result.output.data.posts?.create)).toBe(true);
        expect(Array.isArray(result.output.data.posts?.connect)).toBe(true);
        expect(Array.isArray(result.output.data.posts?.disconnect)).toBe(true);
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

    test("runtime: accepts complex findMany with all options", () => {
      const result = safeParse(schema, {
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
      expect(result.success).toBe(true);
    });

    test("output: preserves complex nested structure", () => {
      const result = safeParse(schema, {
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
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output.take).toBe(10);
        expect(result.output.include?.posts?.take).toBe(3);
        expect(result.output.include?.posts?.orderBy).toEqual({ title: "asc" });
      }
    });
  });

  describe("upsert with nested operations", () => {
    const schema = authorSchemas.args.upsert;

    test("runtime: accepts upsert with nested creates in both branches", () => {
      const result = safeParse(schema, {
        where: { id: "author-1" },
        create: {
          id: "author-1",
          name: "Alice",
          posts: {
            create: [
              { id: "post-1", title: "First", authorId: "author-1" },
              { id: "post-2", title: "Second", authorId: "author-1" },
            ],
          },
        },
        update: {
          name: "Alice Updated",
          posts: {
            create: { id: "post-3", title: "Third", authorId: "author-1" },
            update: {
              where: { id: "post-1" },
              data: { title: "Updated First" },
            },
          },
        },
      });
      expect(result.success).toBe(true);
    });

    test("output: preserves upsert nested create arrays", () => {
      const result = safeParse(schema, {
        where: { id: "author-1" },
        create: {
          id: "author-1",
          name: "Alice",
          posts: {
            create: { id: "post-1", title: "Single", authorId: "author-1" },
          },
        },
        update: {
          posts: {
            create: { id: "post-2", title: "Another", authorId: "author-1" },
          },
        },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        // Both should be normalized to arrays
        expect(Array.isArray(result.output.create.posts?.create)).toBe(true);
        expect(Array.isArray(result.output.update.posts?.create)).toBe(true);
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
      const result = safeParse(schema, {
        where: {
          posts: {
            some: { published: true },
          },
        },
      });
      expect(result.success).toBe(true);
    });

    test("runtime: accepts every relation filter", () => {
      const result = safeParse(schema, {
        where: {
          posts: {
            every: { published: true },
          },
        },
      });
      expect(result.success).toBe(true);
    });

    test("runtime: accepts none relation filter", () => {
      const result = safeParse(schema, {
        where: {
          posts: {
            none: { published: false },
          },
        },
      });
      expect(result.success).toBe(true);
    });

    test("runtime: accepts nested relation filters", () => {
      const result = safeParse(schema, {
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
      expect(result.success).toBe(true);
    });

    test("runtime: accepts combined AND/OR with relation filters", () => {
      const result = safeParse(schema, {
        where: {
          OR: [
            { posts: { some: { published: true } } },
            { name: { startsWith: "Admin" } },
          ],
          AND: [{ posts: { none: { title: { contains: "draft" } } } }],
        },
      });
      expect(result.success).toBe(true);
    });
  });

  describe("Post with author relation filters", () => {
    const schema = postSchemas.args.findMany;

    test("runtime: accepts manyToOne is filter", () => {
      const result = safeParse(schema, {
        where: {
          author: {
            is: { name: "Alice" },
          },
        },
      });
      expect(result.success).toBe(true);
    });

    test("runtime: accepts manyToOne isNot filter", () => {
      const result = safeParse(schema, {
        where: {
          author: {
            isNot: { name: "Bob" },
          },
        },
      });
      expect(result.success).toBe(true);
    });
  });
});
