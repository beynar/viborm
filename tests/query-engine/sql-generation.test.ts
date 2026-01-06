/**
 * Query Engine SQL Generation Tests
 *
 * Comprehensive tests to verify SQL generation for all query operations.
 * Uses QueryEngine.build() to generate SQL without executing.
 */

import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { s } from "@schema";
import { beforeAll, describe, expect, test } from "vitest";

// =============================================================================
// TEST MODELS
// =============================================================================

const Author = s.model({
  id: s.string().id(),
  name: s.string(),
  email: s.string().unique(),
  age: s.int().nullable(),
  posts: s.oneToMany(() => Post),
});

const Post = s
  .model({
    id: s.string().id(),
    title: s.string(),
    content: s.string().nullable(),
    published: s.boolean().default(false),
    views: s.int().default(0),
    authorId: s.string(),
    author: s
      .manyToOne(() => Author)
      .fields("authorId")
      .references("id")
      .optional(),
    comments: s.oneToMany(() => Comment),
    tags: s.manyToMany(() => Tag),
  })
  .map("posts");

const Comment = s
  .model({
    id: s.string().id(),
    text: s.string(),
    postId: s.string(),
    post: s
      .manyToOne(() => Post)
      .fields("postId")
      .references("id"),
  })
  .map("comments");

const Tag = s
  .model({
    id: s.string().id(),
    name: s.string().unique(),
    posts: s.manyToMany(() => Post),
  })
  .map("tags");

// =============================================================================
// TEST SETUP
// =============================================================================

const adapter = new PostgresAdapter();
let registry: ReturnType<typeof createModelRegistry>;
let engine: QueryEngine;

beforeAll(() => {
  registry = createModelRegistry({ Author, Post, Comment, Tag });
  engine = new QueryEngine(adapter, registry);
});

// Helper to get SQL string and values
function getSql(model: any, operation: any, args: any) {
  const sql = engine.build(model, operation, args);
  return {
    statement: sql.toStatement("$n"),
    values: sql.values,
    raw: sql,
  };
}

// =============================================================================
// 1. BASIC CRUD OPERATIONS
// =============================================================================

describe("Basic CRUD Operations", () => {
  describe("findFirst", () => {
    test("simple query", () => {
      const { statement } = getSql(Author, "findFirst", {});
      console.log("findFirst simple:", statement);

      expect(statement).toContain("SELECT");
      expect(statement).toContain("FROM");
      expect(statement).toContain("LIMIT");
    });

    test("with where clause", () => {
      const { statement, values } = getSql(Author, "findFirst", {
        where: { name: "Alice" },
      });
      console.log("findFirst with where:", statement, values);

      expect(statement).toContain("WHERE");
      expect(values).toContain("Alice");
    });

    test("with orderBy", () => {
      const { statement } = getSql(Author, "findFirst", {
        orderBy: { name: "asc" },
      });
      console.log("findFirst with orderBy:", statement);

      expect(statement).toContain("ORDER BY");
      expect(statement).toMatch(/ASC/i);
    });
  });

  describe("findMany", () => {
    test("simple query", () => {
      const { statement } = getSql(Author, "findMany", {});
      console.log("findMany simple:", statement);

      expect(statement).toContain("SELECT");
      expect(statement).toContain("FROM");
    });

    test("with pagination (take/skip)", () => {
      const { statement, values } = getSql(Author, "findMany", {
        take: 10,
        skip: 5,
      });
      console.log("findMany with pagination:", statement, values);

      expect(statement).toContain("LIMIT");
      expect(statement).toContain("OFFSET");
    });

    test.skip("with cursor pagination", () => {
      // Cursor pagination requires more complex setup - skip for now
      const { statement, values } = getSql(Author, "findMany", {
        cursor: { id: "cursor-id" },
        take: 10,
        orderBy: { id: "asc" },
      });
      console.log("findMany with cursor:", statement, values);

      expect(statement).toContain("WHERE");
      expect(values).toContain("cursor-id");
    });
  });

  describe("findUnique", () => {
    test("by id", () => {
      const { statement, values } = getSql(Author, "findUnique", {
        where: { id: "author-1" },
      });
      console.log("findUnique by id:", statement, values);

      expect(statement).toContain("WHERE");
      expect(values).toContain("author-1");
      expect(statement).toContain("LIMIT");
    });

    test("by unique field", () => {
      const { statement, values } = getSql(Author, "findUnique", {
        where: { email: "alice@example.com" },
      });
      console.log("findUnique by email:", statement, values);

      expect(statement).toContain("WHERE");
      expect(values).toContain("alice@example.com");
    });
  });

  describe("create", () => {
    test("simple create", () => {
      const { statement, values } = getSql(Author, "create", {
        data: { id: "author-1", name: "Alice", email: "alice@example.com" },
      });
      console.log("create simple:", statement, values);

      expect(statement).toContain("INSERT INTO");
      expect(statement).toContain("VALUES");
      expect(values).toContain("Alice");
    });

    test("with defaults", () => {
      const { statement, values } = getSql(Post, "create", {
        data: { id: "post-1", title: "Hello", authorId: "author-1" },
      });
      console.log("create with defaults:", statement, values);

      expect(statement).toContain("INSERT INTO");
      // published should default to false, views to 0
    });
  });

  describe("update", () => {
    test("simple update", () => {
      const { statement, values } = getSql(Author, "update", {
        where: { id: "author-1" },
        data: { name: "Alice Updated" },
      });
      console.log("update simple:", statement, values);

      expect(statement).toContain("UPDATE");
      expect(statement).toContain("SET");
      expect(statement).toContain("WHERE");
      expect(values).toContain("Alice Updated");
    });
  });

  describe("delete", () => {
    test("by id", () => {
      const { statement, values } = getSql(Author, "delete", {
        where: { id: "author-1" },
      });
      console.log("delete by id:", statement, values);

      expect(statement).toContain("DELETE FROM");
      expect(statement).toContain("WHERE");
      expect(values).toContain("author-1");
    });
  });
});

// =============================================================================
// 2. SELECT/INCLUDE (RELATION LOADING)
// =============================================================================

describe("Select/Include (Relation Loading)", () => {
  describe("select scalar fields only", () => {
    test("select specific fields", () => {
      const { statement } = getSql(Author, "findMany", {
        select: { id: true, name: true },
      });
      console.log("select scalar fields:", statement);

      expect(statement).toContain("SELECT");
      expect(statement).toContain('"id"');
      expect(statement).toContain('"name"');
    });
  });

  describe("select with to-one relation", () => {
    test("select author on post (manyToOne)", () => {
      const { statement } = getSql(Post, "findMany", {
        select: {
          id: true,
          title: true,
          author: { select: { id: true, name: true } },
        },
      });
      console.log("select with to-one relation:", statement);

      expect(statement).toContain("SELECT");
      // Should have a subquery for author with JSON
      expect(statement).toMatch(/json_build_object|row_to_json/i);
    });
  });

  describe("select with to-many relation", () => {
    test("select posts on author (oneToMany)", () => {
      const { statement } = getSql(Author, "findMany", {
        select: {
          id: true,
          name: true,
          posts: { select: { id: true, title: true } },
        },
      });
      console.log("select with to-many relation:", statement);

      expect(statement).toContain("SELECT");
      // Should have a subquery with json_agg
      expect(statement).toMatch(/json_agg|COALESCE/i);
    });
  });

  describe("nested selects (2-3 levels deep)", () => {
    test("author -> posts -> comments", () => {
      const { statement } = getSql(Author, "findMany", {
        select: {
          id: true,
          name: true,
          posts: {
            select: {
              id: true,
              title: true,
              comments: { select: { id: true, text: true } },
            },
          },
        },
      });
      console.log("nested select 3 levels:", statement);

      expect(statement).toContain("SELECT");
      // Should have nested subqueries
    });
  });

  describe("select with where filter on relation", () => {
    test("select posts with where", () => {
      const { statement, values } = getSql(Author, "findMany", {
        select: {
          id: true,
          posts: {
            where: { published: true },
            select: { id: true, title: true },
          },
        },
      });
      console.log("select with relation where:", statement, values);

      expect(statement).toContain("SELECT");
      expect(statement).toContain("WHERE");
    });
  });

  describe("select with orderBy on relation", () => {
    test("select posts ordered by title", () => {
      const { statement } = getSql(Author, "findMany", {
        select: {
          id: true,
          posts: {
            orderBy: { title: "asc" },
            select: { id: true, title: true },
          },
        },
      });
      console.log("select with relation orderBy:", statement);

      expect(statement).toContain("ORDER BY");
    });
  });

  describe("select with take/skip on relation", () => {
    test("select first 5 posts", () => {
      const { statement } = getSql(Author, "findMany", {
        select: {
          id: true,
          posts: {
            take: 5,
            select: { id: true, title: true },
          },
        },
      });
      console.log("select with relation take:", statement);

      expect(statement).toContain("LIMIT");
    });
  });
});

// =============================================================================
// 3. RELATION FILTERS IN WHERE
// =============================================================================

describe("Relation Filters in WHERE", () => {
  describe("to-many filters", () => {
    test("some filter", () => {
      const { statement, values } = getSql(Author, "findMany", {
        where: {
          posts: {
            some: { published: true },
          },
        },
      });
      console.log("some filter:", statement, values);

      expect(statement).toContain("EXISTS");
    });

    test("every filter", () => {
      const { statement, values } = getSql(Author, "findMany", {
        where: {
          posts: {
            every: { published: true },
          },
        },
      });
      console.log("every filter:", statement, values);

      expect(statement).toContain("NOT EXISTS");
    });

    test("none filter", () => {
      const { statement, values } = getSql(Author, "findMany", {
        where: {
          posts: {
            none: { published: true },
          },
        },
      });
      console.log("none filter:", statement, values);

      expect(statement).toContain("NOT EXISTS");
    });
  });

  describe("to-one filters", () => {
    test("is filter", () => {
      const { statement, values } = getSql(Post, "findMany", {
        where: {
          author: {
            is: { name: "Alice" },
          },
        },
      });
      console.log("is filter:", statement, values);

      expect(statement).toContain("EXISTS");
      expect(values).toContain("Alice");
    });

    test("isNot filter", () => {
      const { statement, values } = getSql(Post, "findMany", {
        where: {
          author: {
            isNot: { name: "Admin" },
          },
        },
      });
      console.log("isNot filter:", statement, values);

      expect(statement).toContain("NOT EXISTS");
    });
  });

  describe("null checks on optional to-one", () => {
    test("is null", () => {
      const { statement } = getSql(Post, "findMany", {
        where: {
          author: {
            is: null,
          },
        },
      });
      console.log("is null filter:", statement);

      expect(statement).toMatch(/IS NULL|NOT EXISTS/i);
    });

    test("isNot null", () => {
      const { statement } = getSql(Post, "findMany", {
        where: {
          author: {
            isNot: null,
          },
        },
      });
      console.log("isNot null filter:", statement);

      expect(statement).toMatch(/IS NOT NULL|EXISTS/i);
    });
  });
});

// =============================================================================
// 4. MANY-TO-MANY RELATIONS
// =============================================================================

describe("Many-to-Many Relations", () => {
  describe("select with manyToMany relation", () => {
    test("select tags on post", () => {
      const { statement } = getSql(Post, "findMany", {
        select: {
          id: true,
          title: true,
          tags: { select: { id: true, name: true } },
        },
      });
      console.log("manyToMany select:", statement);

      // Should use junction table
      expect(statement).toContain("SELECT");
      // Expecting either join through junction or subquery pattern
    });

    test("select posts on tag", () => {
      const { statement } = getSql(Tag, "findMany", {
        select: {
          id: true,
          name: true,
          posts: { select: { id: true, title: true } },
        },
      });
      console.log("manyToMany reverse select:", statement);

      expect(statement).toContain("SELECT");
    });
  });

  describe("filter with manyToMany", () => {
    test("some filter through junction", () => {
      const { statement, values } = getSql(Post, "findMany", {
        where: {
          tags: {
            some: { name: "typescript" },
          },
        },
      });
      console.log("manyToMany some filter:", statement, values);

      expect(statement).toContain("EXISTS");
    });

    test("every filter through junction", () => {
      const { statement } = getSql(Post, "findMany", {
        where: {
          tags: {
            every: { name: "typescript" },
          },
        },
      });
      console.log("manyToMany every filter:", statement);

      expect(statement).toContain("NOT EXISTS");
    });

    test("none filter through junction", () => {
      const { statement } = getSql(Post, "findMany", {
        where: {
          tags: {
            none: { name: "deprecated" },
          },
        },
      });
      console.log("manyToMany none filter:", statement);

      expect(statement).toContain("NOT EXISTS");
    });
  });
});

// =============================================================================
// 5. RELATION _COUNT
// =============================================================================

describe("Relation _count", () => {
  test("count posts on author", () => {
    const { statement } = getSql(Author, "findMany", {
      select: {
        id: true,
        name: true,
        _count: {
          select: { posts: true },
        },
      },
    });
    console.log("_count posts:", statement);

    expect(statement).toContain("SELECT");
    expect(statement).toContain("COUNT");
  });

  test("count with filter", () => {
    const { statement } = getSql(Author, "findMany", {
      select: {
        id: true,
        _count: {
          select: {
            posts: { where: { published: true } },
          },
        },
      },
    });
    console.log("_count with filter:", statement);

    expect(statement).toContain("COUNT");
    expect(statement).toContain("WHERE");
  });
});

// =============================================================================
// 6. NESTED WRITES
// =============================================================================

describe("Nested Writes", () => {
  describe("create with nested", () => {
    test("create with connect", () => {
      const { statement, values } = getSql(Post, "create", {
        data: {
          id: "post-1",
          title: "Hello",
          author: {
            connect: { id: "author-1" },
          },
        },
      });
      console.log("create with connect:", statement, values);

      expect(statement).toContain("INSERT");
    });

    test("create with nested create", () => {
      const { statement, values } = getSql(Author, "create", {
        data: {
          id: "author-1",
          name: "Alice",
          email: "alice@example.com",
          posts: {
            create: { id: "post-1", title: "First Post" },
          },
        },
      });
      console.log("create with nested create:", statement, values);

      expect(statement).toContain("INSERT");
    });

    test("create with nested create and return nested", () => {
      const { statement, values } = getSql(Author, "create", {
        data: {
          id: "author-1",
          name: "Alice",
          email: "alice@example.com",
          posts: {
            create: [
              { id: "post-1", title: "First Post" },
              { id: "post-2", title: "Second Post" },
            ],
          },
        },
        select: {
          id: true,
          name: true,
          posts: {
            select: { id: true, title: true },
          },
        },
      });
      console.log(
        "create with nested create and return nested:",
        statement,
        values
      );

      // Should contain multi-statement with semicolons
      expect(statement).toContain(";");
      // Should have parent INSERT
      expect(statement).toContain('INSERT INTO "Author"');
      // Should have child INSERTs
      expect(statement).toContain('INSERT INTO "posts"');
      // Should have final SELECT with JSON aggregation for posts
      expect(statement).toContain("SELECT");
      expect(statement).toContain("json_agg");
      expect(statement).toContain('"posts"');
    });
  });

  describe("update with nested", () => {
    test("update with connect", () => {
      const { statement, values } = getSql(Post, "update", {
        where: { id: "post-1" },
        data: {
          author: {
            connect: { id: "author-2" },
          },
        },
      });
      console.log("update with connect:", statement, values);

      expect(statement).toContain("UPDATE");
    });

    test("update with disconnect", () => {
      const { statement } = getSql(Post, "update", {
        where: { id: "post-1" },
        data: {
          author: {
            disconnect: true,
          },
        },
      });
      console.log("update with disconnect:", statement);

      expect(statement).toContain("UPDATE");
    });
  });
});

// =============================================================================
// 7. AGGREGATES
// =============================================================================

describe("Aggregates", () => {
  describe("count", () => {
    test("simple count", () => {
      const { statement } = getSql(Author, "count", {});
      console.log("count simple:", statement);

      expect(statement).toContain("COUNT");
    });

    test("count with where", () => {
      const { statement, values } = getSql(Author, "count", {
        where: { name: "Alice" },
      });
      console.log("count with where:", statement, values);

      expect(statement).toContain("COUNT");
      expect(statement).toContain("WHERE");
    });
  });

  describe("aggregate", () => {
    test("with _sum, _avg, _min, _max", () => {
      const { statement } = getSql(Post, "aggregate", {
        _sum: { views: true },
        _avg: { views: true },
        _min: { views: true },
        _max: { views: true },
      });
      console.log("aggregate:", statement);

      expect(statement).toContain("SUM");
      expect(statement).toContain("AVG");
      expect(statement).toContain("MIN");
      expect(statement).toContain("MAX");
    });
  });

  describe("groupBy", () => {
    // TODO: having clause with aggregate functions (_count, etc.) needs special schema support
    test.skip("with having", () => {
      const { statement, values } = getSql(Post, "groupBy", {
        by: ["authorId"],
        _count: { id: true },
        having: {
          id: {
            _count: { gt: 5 },
          },
        },
      });
      console.log("groupBy with having:", statement, values);

      expect(statement).toContain("GROUP BY");
      expect(statement).toContain("HAVING");
    });
  });
});
