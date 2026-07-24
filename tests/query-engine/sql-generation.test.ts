/**
 * Query Engine SQL Generation Tests
 *
 * Comprehensive tests to verify SQL generation for all query operations.
 * Uses QueryEngine.build() to generate SQL without executing.
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { type Dialect, Driver } from "@drivers";
import { ValidationError } from "@errors";
import { buildOrderByParts } from "@query-engine/builders/orderby-builder";
import { buildWhere } from "@query-engine/builders/where-builder";
import { buildWhereUnique } from "@query-engine/builders/where-unique-builder";
import { createQueryScope, getTableName } from "@query-engine/context";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import { createSchemaRegistry } from "@validation";
import { beforeAll, describe, expect, test } from "vitest";
import { sqlGenerationUserPostSchema } from "../fixtures/user-post-schema";

const DESC_SQL = /DESC/i;
const LEFT_JOIN_SQL = /LEFT JOIN/i;
const ORDER_BY_COUNT_SQL = /ORDER BY \(SELECT COUNT\(\*\)/i;

// =============================================================================
// MOCK DRIVER FOR TESTING
// =============================================================================

class MockDriver extends Driver<null, null> {
  readonly adapter: DatabaseAdapter;

  constructor(
    adapter: DatabaseAdapter,
    dialect: Dialect = "postgresql",
    driverName = `mock-${dialect}`
  ) {
    super(dialect, driverName);
    this.adapter = adapter;
  }

  protected async initClient() {
    return null;
  }

  protected async closeClient() {
    // The SQL-only driver opens no provider resource.
  }

  protected async execute<T>(
    _client: null,
    _statement: string,
    _params: unknown[]
  ): Promise<{ rows: T[]; rowCount: number }> {
    return { rows: [], rowCount: 0 };
  }

  protected async executeRaw<T>(
    _client: null,
    _statement: string,
    _params?: unknown[]
  ): Promise<{ rows: T[]; rowCount: number }> {
    return { rows: [], rowCount: 0 };
  }

  protected async transaction<T>(
    _client: null,
    fn: (tx: null) => Promise<T>
  ): Promise<T> {
    return fn(null);
  }
}

const ASC_REGEX = /ASC/i;
const DESC_REGEX = /DESC/i;
const JSON_OBJECT_REGEX = /json_build_object|row_to_json/i;
const JSON_AGG_REGEX = /json_agg|COALESCE/i;
const IS_NULL_REGEX = /IS NULL|NOT EXISTS/i;
const IS_NOT_NULL_REGEX = /IS NOT NULL|EXISTS/i;

// =============================================================================
// TEST MODELS
// =============================================================================

const { Author, Post, Tag, Membership } = sqlGenerationUserPostSchema;

const nestedRelationOrderBySchema = (() => {
  const Country = s
    .model({
      id: s.string().id(),
      name: s.string(),
    })
    .map("nested_order_countries");

  const Publisher = s
    .model({
      id: s.string().id(),
      name: s.string(),
      rank: s.int(),
      countryId: s.string(),
      country: s
        .manyToOne(() => Country)
        .fields("countryId")
        .references("id"),
    })
    .map("nested_order_publishers");

  const Author = s
    .model({
      id: s.string().id(),
      name: s.string(),
      publisherId: s.string(),
      publisher: s
        .manyToOne(() => Publisher)
        .fields("publisherId")
        .references("id"),
      posts: s.oneToMany(() => NestedPost),
    })
    .map("nested_order_authors");

  const NestedPost = s
    .model({
      id: s.string().id(),
      title: s.string(),
      authorId: s.string(),
      author: s
        .manyToOne(() => Author)
        .fields("authorId")
        .references("id"),
    })
    .map("nested_order_posts");

  const Comment = s
    .model({
      id: s.string().id(),
      text: s.string(),
      postId: s.string(),
      post: s
        .manyToOne(() => NestedPost)
        .fields("postId")
        .references("id"),
    })
    .map("nested_order_comments");

  return { Country, Publisher, Author, NestedPost, Comment };
})();

// =============================================================================
// TEST SETUP
// =============================================================================

const schema = sqlGenerationUserPostSchema;

// Hydrate schema names before tests
hydrateSchemaNames(schema);

const adapter = new PostgresAdapter();
const mockDriver = new MockDriver(adapter);

interface DialectCase {
  name: string;
  dialect: Dialect;
  createAdapter: () => DatabaseAdapter;
}

const dialectCases: DialectCase[] = [
  {
    name: "PostgreSQL",
    dialect: "postgresql",
    createAdapter: () => new PostgresAdapter(),
  },
  {
    name: "SQLite",
    dialect: "sqlite",
    createAdapter: () => new SQLiteAdapter(),
  },
  {
    name: "MySQL",
    dialect: "mysql",
    createAdapter: () => new MySQLAdapter(),
  },
];

let registry: ReturnType<typeof createModelRegistry>;
let engine: QueryEngine;

beforeAll(() => {
  registry = createModelRegistry(schema, createSchemaRegistry(schema));
  engine = new QueryEngine(mockDriver, registry);
  hydrateSchemaNames(nestedRelationOrderBySchema);
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

function getWhiteBoxOrderByParts(model: any, orderBy: Record<string, unknown>) {
  const ctx = createQueryScope(adapter, model);
  return buildOrderByParts(ctx, orderBy, ctx.rootAlias);
}

// =============================================================================
// 1. BASIC CRUD OPERATIONS
// =============================================================================

describe("Basic CRUD Operations", () => {
  describe("findFirst", () => {
    test("simple query", () => {
      const { statement } = getSql(Author, "findFirst", {});

      expect(statement).toContain("SELECT");
      expect(statement).toContain("FROM");
      expect(statement).toContain("LIMIT");
    });

    test("with where clause", () => {
      const { statement, values } = getSql(Author, "findFirst", {
        where: { name: "Alice" },
      });

      expect(statement).toContain("WHERE");
      expect(values).toContain("Alice");
    });

    test("with orderBy", () => {
      const { statement } = getSql(Author, "findFirst", {
        orderBy: { name: "asc" },
      });

      expect(statement).toContain("ORDER BY");
      expect(statement).toMatch(ASC_REGEX);
    });
  });

  describe("findMany", () => {
    test("simple query", () => {
      const { statement } = getSql(Author, "findMany", {});

      expect(statement).toContain("SELECT");
      expect(statement).toContain("FROM");
    });

    test("with pagination (take/skip)", () => {
      const { statement } = getSql(Author, "findMany", {
        take: 10,
        skip: 5,
      });

      expect(statement).toContain("LIMIT");
      expect(statement).toContain("OFFSET");
    });

    test("with cursor pagination", () => {
      const { statement, values } = getSql(Author, "findMany", {
        cursor: { id: "cursor-id" },
        take: 10,
        orderBy: { id: "asc" },
      });

      expect(statement).toContain("WHERE");
      expect(values).toContain("cursor-id");
    });

    test("cursor without orderBy defaults to cursor field order", () => {
      const { statement, values } = getSql(Author, "findMany", {
        cursor: { id: "cursor-id" },
        take: 10,
      });

      expect(statement).toContain("ORDER BY");
      expect(statement).toContain('"t0"."id" ASC');
      expect(values).toContain("cursor-id");
    });

    test("negative take inverts SQL order and uses absolute limit", () => {
      const { statement, values } = getSql(Author, "findMany", {
        cursor: { id: "cursor-id" },
        orderBy: { id: "asc" },
        take: -2,
      });

      expect(statement).toContain("ORDER BY");
      expect(statement).toMatch(DESC_REGEX);
      expect(statement).toContain("LIMIT");
      expect(values).toContain(2);
      expect(values).not.toContain(-2);
    });

    test("compound unique cursor uses compound whereUnique fields", () => {
      const { statement, values } = getSql(Membership, "findMany", {
        cursor: {
          orgId_memberId: { orgId: "org-1", memberId: "member-2" },
        },
        take: 2,
      });

      expect(statement).toContain('"t0"."orgId"');
      expect(statement).toContain('"t0"."memberId"');
      expect(statement).toContain("ORDER BY");
      expect(values).toContain("org-1");
      expect(values).toContain("member-2");
    });

    test("cursor with non-cursor orderBy builds a keyset comparison (Prisma parity)", () => {
      const { statement, values } = getSql(Author, "findMany", {
        cursor: { id: "cursor-id" },
        orderBy: { name: "asc" },
        take: 2,
      });

      // The order column drives the comparison; the cursor row's value for it
      // comes from a scalar subquery on the cursor's unique field.
      expect(statement).toContain("ORDER BY");
      expect(statement).toContain('"t0"."name"');
      expect(statement).toContain("(SELECT");
      expect(values).toContain("cursor-id");
    });

    test("invalid pagination values reject before SQL generation", () => {
      expect(() =>
        getSql(Author, "findMany", {
          take: 1.5,
        })
      ).toThrow(ValidationError);
      expect(() =>
        getSql(Author, "findMany", {
          skip: -1,
        })
      ).toThrow(ValidationError);
    });

    test("json path filter scopes string matching to the path", () => {
      const { statement, values } = getSql(Author, "findMany", {
        where: {
          metadata: {
            path: ["status"],
            string_contains: "active",
          },
        },
      });

      expect(statement).toContain("#>>");
      expect(statement).toContain("POSITION");
      expect(values).toContainEqual(["status"]);
      expect(values).toContain("active");
    });

    test("json filter with only a path fails closed", () => {
      expect(() =>
        getSql(Author, "findMany", {
          where: {
            metadata: {
              path: ["status"],
            },
          },
        })
      ).toThrow(
        "Filter for field 'metadata' must contain at least one operation"
      );
    });

    test("empty accepted scalar filter fails closed", () => {
      expect(() =>
        getSql(Author, "findMany", {
          where: {
            name: {},
          },
        })
      ).toThrow("Filter for field 'name' must contain at least one operation");
    });

    test("empty accepted relation filter fails closed", () => {
      expect(() =>
        getSql(Author, "findMany", {
          where: {
            posts: {},
          },
        })
      ).toThrow("Relation filter 'posts' requires one of: some, every, none");
    });

    test("empty OR filter does not broaden the query", () => {
      const { statement } = getSql(Author, "findMany", {
        where: {
          OR: [],
        },
      });

      expect(statement).toContain("WHERE");
      expect(statement).toContain("FALSE");
    });

    test("to-one relation scalar orderBy joins related table", () => {
      const { statement } = getSql(Post, "findMany", {
        orderBy: { author: { name: "asc" } },
      });

      expect(statement).toMatch(LEFT_JOIN_SQL);
      expect(statement).toContain('ORDER BY "t1"."name" ASC');
    });

    test("builder chains 2-hop to-one relation orderBy joins", () => {
      const parts = getWhiteBoxOrderByParts(
        nestedRelationOrderBySchema.NestedPost,
        {
          author: {
            publisher: {
              name: "asc",
              rank: "desc",
            },
          },
        }
      );
      const joins = parts.joins.map((join) => join.toStatement("$n"));

      expect(joins).toHaveLength(2);
      expect(joins[0]).toContain(
        'LEFT JOIN "nested_order_authors" AS "t1" ON "t0"."authorId" = "t1"."id"'
      );
      expect(joins[1]).toContain(
        'LEFT JOIN "nested_order_publishers" AS "t2" ON "t1"."publisherId" = "t2"."id"'
      );
      expect(parts.orderBy?.toStatement("$n")).toBe(
        '"t2"."name" ASC, "t2"."rank" DESC'
      );
    });

    test("builder chains 3-hop to-one relation orderBy joins", () => {
      const parts = getWhiteBoxOrderByParts(
        nestedRelationOrderBySchema.Comment,
        {
          post: {
            author: {
              publisher: {
                name: "asc",
              },
            },
          },
        }
      );
      const joins = parts.joins.map((join) => join.toStatement("$n"));

      expect(joins).toHaveLength(3);
      expect(joins[0]).toContain(
        'LEFT JOIN "nested_order_posts" AS "t1" ON "t0"."postId" = "t1"."id"'
      );
      expect(joins[1]).toContain(
        'LEFT JOIN "nested_order_authors" AS "t2" ON "t1"."authorId" = "t2"."id"'
      );
      expect(joins[2]).toContain(
        'LEFT JOIN "nested_order_publishers" AS "t3" ON "t2"."publisherId" = "t3"."id"'
      );
      expect(parts.orderBy?.toStatement("$n")).toBe('"t3"."name" ASC');
    });

    test("builder rejects to-many relation orderBy mid-chain", () => {
      expect(() =>
        getWhiteBoxOrderByParts(nestedRelationOrderBySchema.NestedPost, {
          author: {
            posts: {
              _count: "desc",
            },
          },
        })
      ).toThrow(
        "Relation orderBy 'author.posts' cannot order through a to-many relation; use '_count'."
      );
    });

    test("builder rejects relation orderBy past the depth cap", () => {
      expect(() =>
        getWhiteBoxOrderByParts(nestedRelationOrderBySchema.Comment, {
          post: {
            author: {
              publisher: {
                country: {
                  name: "asc",
                },
              },
            },
          },
        })
      ).toThrow(
        "Relation orderBy path 'post.author.publisher.country' exceeds maximum depth of 3 relation hops."
      );
    });

    test("to-many relation _count orderBy uses count subquery", () => {
      const { statement } = getSql(Author, "findMany", {
        orderBy: { posts: { _count: "desc" } },
      });

      expect(statement).not.toMatch(LEFT_JOIN_SQL);
      expect(statement).toMatch(ORDER_BY_COUNT_SQL);
      expect(statement).toContain('FROM "posts" AS "t1"');
      expect(statement).toMatch(DESC_SQL);
    });

    test("to-many relation scalar orderBy fails closed", () => {
      expect(() =>
        getSql(Author, "findMany", {
          orderBy: { posts: { title: "asc" } },
        })
      ).toThrow();
    });

    test("nested relation orderBy shape fails closed", () => {
      expect(() =>
        getSql(Post, "findMany", {
          orderBy: { author: { posts: { _count: "desc" } } },
        })
      ).toThrow();
    });

    test("unknown builder filter operation fails closed", () => {
      const ctx = createQueryScope(adapter, Author);

      expect(() =>
        buildWhere(ctx, { age: { unsupported: 1 } }, ctx.rootAlias)
      ).toThrow(
        "Unsupported filter operation 'unsupported' for int scalar 'age'"
      );
    });

    test("unknown builder where field fails closed", () => {
      const ctx = createQueryScope(adapter, Author);

      expect(() =>
        buildWhere(ctx, { unknownField: { equals: "value" } }, ctx.rootAlias)
      ).toThrow("Unknown where field 'unknownField'");
    });

    test("empty unique builder fails closed", () => {
      const ctx = createQueryScope(adapter, Author);

      expect(() => buildWhereUnique(ctx, {}, ctx.rootAlias)).toThrow(
        "whereUnique requires at least one unique discriminator"
      );
    });

    test("non-unique unique builder field fails closed", () => {
      const ctx = createQueryScope(adapter, Author);

      expect(() =>
        buildWhereUnique(ctx, { name: "Alice" }, ctx.rootAlias)
      ).toThrow("whereUnique field 'name' is not a unique discriminator");
    });
  });

  describe("findUnique", () => {
    test("by id", () => {
      const { statement, values } = getSql(Author, "findUnique", {
        where: { id: "author-1" },
      });

      expect(statement).toContain("WHERE");
      expect(values).toContain("author-1");
      expect(statement).toContain("LIMIT");
    });

    test("by unique field", () => {
      const { statement, values } = getSql(Author, "findUnique", {
        where: { email: "alice@example.com" },
      });

      expect(statement).toContain("WHERE");
      expect(values).toContain("alice@example.com");
    });

    test("empty where fails before SQL generation", () => {
      expect(() =>
        getSql(Author, "findUnique", {
          where: {},
        })
      ).toThrow("Object cannot be empty");
    });

    test("by compound id", () => {
      const { statement, values } = getSql(Membership, "findUnique", {
        where: {
          orgId_memberId: { orgId: "org-1", memberId: "member-1" },
        },
      });

      expect(statement).toContain("WHERE");
      expect(values).toContain("org-1");
      expect(values).toContain("member-1");
    });

    test("by compound unique", () => {
      const { statement, values } = getSql(Membership, "findUnique", {
        where: {
          email_tenantId: { email: "alice@example.com", tenantId: "tenant-1" },
        },
      });

      expect(statement).toContain("WHERE");
      expect(values).toContain("alice@example.com");
      expect(values).toContain("tenant-1");
    });
  });

  describe("create", () => {
    test("simple create", () => {
      const { statement, values } = getSql(Author, "create", {
        data: { id: "author-1", name: "Alice", email: "alice@example.com" },
      });

      expect(statement).toContain("INSERT INTO");
      expect(statement).toContain("VALUES");
      expect(values).toContain("Alice");
    });

    test("with defaults", () => {
      const { statement } = getSql(Post, "create", {
        data: { id: "post-1", title: "Hello", authorId: "author-1" },
      });

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

      expect(statement).toContain("UPDATE");
      expect(statement).toContain("SET");
      expect(statement).toContain("WHERE");
      expect(values).toContain("Alice Updated");
    });

    test("empty where fails before SQL generation", () => {
      expect(() =>
        getSql(Author, "update", {
          where: {},
          data: { name: "Alice Updated" },
        })
      ).toThrow("Object cannot be empty");
    });
  });

  describe("delete", () => {
    test("multi-step delete rejects the single-statement build API", () => {
      // A root delete locates the row by its unique `where` (a notFound-enforcing
      // planning read) before deleting it, so it is a multi-statement operation —
      // the single-statement `build()` API rejects it, exactly as it does an
      // upsert. The delete's persisted effect is covered by the delete-behavior and
      // nested-write-conformance suites.
      expect(() =>
        getSql(Author, "delete", {
          where: { id: "author-1" },
        })
      ).toThrow(
        "Operation 'delete' does not compile to one SQL statement. Execute the operation instead."
      );
    });

    test("empty where fails before SQL generation", () => {
      expect(() =>
        getSql(Author, "delete", {
          where: {},
        })
      ).toThrow("Object cannot be empty");
    });
  });

  describe("upsert", () => {
    test("empty where fails before SQL generation", () => {
      expect(() =>
        getSql(Author, "upsert", {
          where: {},
          create: {
            id: "author-1",
            name: "Alice",
            email: "alice@example.com",
          },
          update: { name: "Alice Updated" },
        })
      ).toThrow("Object cannot be empty");
    });

    test("multi-step upsert rejects the single-statement build API", () => {
      expect(() =>
        getSql(Author, "upsert", {
          where: { id: "author-1" },
          create: {
            id: "author-1",
            name: "Alice",
            email: "alice@example.com",
          },
          update: {
            posts: {
              update: {
                where: { id: "post-1" },
                data: { title: "Updated" },
              },
            },
          },
        })
      ).toThrow(
        "Operation 'upsert' does not compile to one SQL statement. Execute the operation instead."
      );
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

      expect(statement).toContain("SELECT");
      // Should have a subquery for author with JSON
      expect(statement).toMatch(JSON_OBJECT_REGEX);
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

      expect(statement).toContain("SELECT");
      // Should have a subquery with json_agg
      expect(statement).toMatch(JSON_AGG_REGEX);
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

      expect(statement).toContain("SELECT");
      // Should use recursive LATERAL joins for nested includes (posts + comments)
      const lateralCount = (statement.match(/LEFT JOIN LATERAL/g) ?? []).length;
      expect(lateralCount).toBeGreaterThanOrEqual(2);
    });
  });

  describe("select with where filter on relation", () => {
    test("select posts with where", () => {
      const { statement } = getSql(Author, "findMany", {
        select: {
          id: true,
          posts: {
            where: { published: true },
            select: { id: true, title: true },
          },
        },
      });

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

      expect(statement).toContain("LIMIT");
    });

    test("select posts with skip", () => {
      const { statement } = getSql(Author, "findMany", {
        select: {
          id: true,
          posts: {
            skip: 10,
            select: { id: true, title: true },
          },
        },
      });

      expect(statement).toContain("OFFSET");
    });

    test("select posts with take and skip", () => {
      const { statement } = getSql(Author, "findMany", {
        select: {
          id: true,
          posts: {
            take: 5,
            skip: 10,
            select: { id: true, title: true },
          },
        },
      });

      expect(statement).toContain("LIMIT");
      expect(statement).toContain("OFFSET");
    });
  });
});

// =============================================================================
// 3. RELATION FILTERS IN WHERE
// =============================================================================

describe("Relation Filters in WHERE", () => {
  describe("to-many filters", () => {
    test("some filter", () => {
      const { statement } = getSql(Author, "findMany", {
        where: {
          posts: {
            some: { published: true },
          },
        },
      });

      expect(statement).toContain("EXISTS");
    });

    test("every filter", () => {
      const { statement } = getSql(Author, "findMany", {
        where: {
          posts: {
            every: { published: true },
          },
        },
      });

      expect(statement).toContain("NOT EXISTS");
    });

    test("none filter", () => {
      const { statement } = getSql(Author, "findMany", {
        where: {
          posts: {
            none: { published: true },
          },
        },
      });

      expect(statement).toContain("NOT EXISTS");
    });

    test("combines all supplied filters independent of key order", () => {
      const ordered = getSql(Author, "findMany", {
        where: {
          posts: {
            some: { title: "some-title" },
            every: { title: "every-title" },
            none: { title: "none-title" },
          },
        },
      });
      const reordered = getSql(Author, "findMany", {
        where: {
          posts: {
            none: { title: "none-title" },
            every: { title: "every-title" },
            some: { title: "some-title" },
          },
        },
      });

      expect(ordered.statement).toBe(reordered.statement);
      expect(ordered.values).toEqual(reordered.values);
      expect(ordered.statement.match(/EXISTS/g)).toHaveLength(3);
      expect(ordered.statement).toContain(" AND ");
      expect(ordered.values).toEqual([
        "some-title",
        "every-title",
        "none-title",
      ]);
    });

    test("empty every predicates lower to portable true", () => {
      const empty = getSql(Author, "findMany", {
        where: { posts: { every: {} } },
      });
      const normalizedEmpty = getSql(Author, "findMany", {
        where: { posts: { every: { AND: [{}] } } },
      });

      expect(empty.statement).not.toContain("EXISTS");
      expect(normalizedEmpty.statement).not.toContain("EXISTS");
      expect(empty.statement).toContain("TRUE");
      expect(normalizedEmpty.statement).toContain("TRUE");
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

      expect(statement).toContain("EXISTS");
      expect(values).toContain("Alice");
    });

    test("isNot filter", () => {
      const { statement } = getSql(Post, "findMany", {
        where: {
          author: {
            isNot: { name: "Admin" },
          },
        },
      });

      expect(statement).toContain("NOT EXISTS");
    });

    test("combines is and isNot independent of key order", () => {
      const ordered = getSql(Post, "findMany", {
        where: {
          author: {
            is: { name: "Alice" },
            isNot: { name: "Admin" },
          },
        },
      });
      const reordered = getSql(Post, "findMany", {
        where: {
          author: {
            isNot: { name: "Admin" },
            is: { name: "Alice" },
          },
        },
      });

      expect(ordered.statement).toBe(reordered.statement);
      expect(ordered.values).toEqual(reordered.values);
      expect(ordered.statement.match(/EXISTS/g)).toHaveLength(2);
      expect(ordered.statement).toContain(" AND ");
      expect(ordered.values).toEqual(["Alice", "Admin"]);
    });

    test("combines null and object forms", () => {
      const isNull = getSql(Post, "findMany", {
        where: {
          author: {
            is: null,
            isNot: { name: "Alice" },
          },
        },
      });
      const isNotNull = getSql(Post, "findMany", {
        where: {
          author: {
            is: { name: "Alice" },
            isNot: null,
          },
        },
      });

      expect(isNull.statement).toMatch(IS_NULL_REGEX);
      expect(isNull.statement).toContain("NOT EXISTS");
      expect(isNull.statement).toContain(" AND ");
      expect(isNotNull.statement).toContain("EXISTS");
      expect(isNotNull.statement).toMatch(IS_NOT_NULL_REGEX);
      expect(isNotNull.statement).toContain(" AND ");
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

      expect(statement).toMatch(IS_NULL_REGEX);
    });

    test("isNot null", () => {
      const { statement } = getSql(Post, "findMany", {
        where: {
          author: {
            isNot: null,
          },
        },
      });

      expect(statement).toMatch(IS_NOT_NULL_REGEX);
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

      // Should use junction table
      expect(statement).toContain("SELECT");
      // Should use LATERAL join strategy for includes (PostgreSQL adapter)
      expect(statement).toContain("LEFT JOIN LATERAL");
      expect(statement).toContain('"post_tag"');
    });

    test("select posts on tag", () => {
      const { statement } = getSql(Tag, "findMany", {
        select: {
          id: true,
          name: true,
          posts: { select: { id: true, title: true } },
        },
      });

      expect(statement).toContain("SELECT");
      expect(statement).toContain("LEFT JOIN LATERAL");
      expect(statement).toContain('"post_tag"');
    });
  });

  describe("filter with manyToMany", () => {
    test("some filter through junction", () => {
      const { statement } = getSql(Post, "findMany", {
        where: {
          tags: {
            some: { name: "typescript" },
          },
        },
      });

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

      expect(statement).toContain("NOT EXISTS");
    });

    test("combines all supplied filters through the junction independent of key order", () => {
      const ordered = getSql(Post, "findMany", {
        where: {
          tags: {
            some: { name: "some-tag" },
            every: { name: "every-tag" },
            none: { name: "none-tag" },
          },
        },
      });
      const reordered = getSql(Post, "findMany", {
        where: {
          tags: {
            none: { name: "none-tag" },
            every: { name: "every-tag" },
            some: { name: "some-tag" },
          },
        },
      });

      expect(ordered.statement).toBe(reordered.statement);
      expect(ordered.values).toEqual(reordered.values);
      expect(ordered.statement.match(/EXISTS/g)).toHaveLength(3);
      expect(ordered.statement).toContain(" AND ");
      expect(ordered.values).toEqual(["some-tag", "every-tag", "none-tag"]);
    });

    test("empty every through the junction lowers to portable true", () => {
      const empty = getSql(Post, "findMany", {
        where: { tags: { every: {} } },
      });
      const normalizedEmpty = getSql(Post, "findMany", {
        where: { tags: { every: { AND: [{}] } } },
      });

      expect(empty.statement).not.toContain("EXISTS");
      expect(empty.statement).not.toContain("post_tag");
      expect(normalizedEmpty.statement).not.toContain("EXISTS");
      expect(normalizedEmpty.statement).not.toContain("post_tag");
      expect(empty.statement).toContain("TRUE");
      expect(normalizedEmpty.statement).toContain("TRUE");
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

    expect(statement).toContain("COUNT");
    expect(statement).toContain("WHERE");
  });
});

// =============================================================================
// 6. NESTED WRITES
// =============================================================================

describe("Multi-step writes", () => {
  describe("create with nested", () => {
    test("create with connect rejects the single-statement build API", () => {
      expect(() =>
        getSql(Post, "create", {
          data: {
            id: "post-1",
            title: "Hello",
            author: {
              connect: { id: "author-1" },
            },
          },
        })
      ).toThrow(
        "Operation 'create' does not compile to one SQL statement. Execute the operation instead."
      );
    });

    test("create with nested create rejects the single-statement build API", () => {
      expect(() =>
        getSql(Author, "create", {
          data: {
            id: "author-1",
            name: "Alice",
            email: "alice@example.com",
            posts: {
              create: { id: "post-1", title: "First Post" },
            },
          },
        })
      ).toThrow(
        "Operation 'create' does not compile to one SQL statement. Execute the operation instead."
      );
    });

    test("create with nested createMany rejects the single-statement build API", () => {
      expect(() =>
        getSql(Author, "create", {
          data: {
            id: "author-1",
            name: "Alice",
            email: "alice@example.com",
            posts: {
              createMany: {
                data: [{ id: "post-1", title: "First Post" }],
              },
            },
          },
        })
      ).toThrow(
        "Operation 'create' does not compile to one SQL statement. Execute the operation instead."
      );
    });

    test("create with nested create list rejects the single-statement build API", () => {
      expect(() =>
        getSql(Author, "create", {
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
        })
      ).toThrow(
        "Operation 'create' does not compile to one SQL statement. Execute the operation instead."
      );
    });
  });

  describe("update with nested", () => {
    test("update with connect rejects the single-statement build API", () => {
      expect(() =>
        getSql(Post, "update", {
          where: { id: "post-1" },
          data: {
            author: {
              connect: { id: "author-2" },
            },
          },
        })
      ).toThrow(
        "Operation 'update' does not compile to one SQL statement. Execute the operation instead."
      );
    });

    test("required relation disconnect fails before SQL generation", () => {
      expect(() =>
        getSql(Post, "update", {
          where: { id: "post-1" },
          data: {
            author: {
              disconnect: true,
            },
          },
        })
      ).toThrow(
        "Cannot disconnect relation 'author' because foreign key field(s) authorId are required."
      );
    });

    test("update with nested update rejects the single-statement build API", () => {
      expect(() =>
        getSql(Author, "update", {
          where: { id: "author-1" },
          data: {
            posts: {
              update: {
                where: { id: "post-1" },
                data: { title: "Updated" },
              },
            },
          },
        })
      ).toThrow(
        "Operation 'update' does not compile to one SQL statement. Execute the operation instead."
      );
    });
  });

  describe("dialect top-level relation-filter mutations", () => {
    // Parent column inside the EXISTS subquery must be qualified with the
    // mutation target's table name; unqualified it binds to the related
    // table and decorrelates the subquery (affecting the wrong rows).
    const qualifiedAuthorId = new RegExp(
      `["\`]${getTableName(Author)}["\`]\\.["\`]id["\`]`
    );

    test.each(
      dialectCases
    )("$name updateMany relation filter stays correlated to the target table", ({
      createAdapter,
      dialect,
    }) => {
      const dialectEngine = new QueryEngine(
        new MockDriver(createAdapter(), dialect),
        registry
      );
      const statement = dialectEngine
        .build(Author, "updateMany", {
          where: { posts: { some: { title: "Draft" } } },
          data: { name: "Updated" },
        })
        .toStatement("$n");

      expect(statement).toContain("UPDATE");
      expect(statement).toContain("EXISTS");
      expect(statement).toMatch(qualifiedAuthorId);
    });

    test.each(
      dialectCases
    )("$name deleteMany relation filter stays correlated to the target table", ({
      createAdapter,
      dialect,
    }) => {
      const dialectEngine = new QueryEngine(
        new MockDriver(createAdapter(), dialect),
        registry
      );
      const statement = dialectEngine
        .build(Author, "deleteMany", {
          where: { posts: { some: { title: "Draft" } } },
        })
        .toStatement("$n");

      expect(statement).toContain("DELETE");
      expect(statement).toContain("EXISTS");
      expect(statement).toMatch(qualifiedAuthorId);
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

      expect(statement).toContain("COUNT");
    });

    test("count with where", () => {
      const { statement } = getSql(Author, "count", {
        where: { name: "Alice" },
      });

      expect(statement).toContain("COUNT");
      expect(statement).toContain("WHERE");
    });

    test("with order and pagination counts an input subquery", () => {
      const { statement, values } = getSql(Author, "count", {
        orderBy: { age: "desc" },
        skip: 1,
        take: 2,
      });

      expect(statement).toContain("COUNT");
      expect(statement).toContain("FROM (SELECT");
      expect(statement).toContain("aggregate_input");
      expect(statement).toContain("ORDER BY");
      expect(statement).toMatch(DESC_REGEX);
      expect(statement).toContain("LIMIT");
      expect(statement).toContain("OFFSET");
      expect(values).toContain(2);
      expect(values).toContain(1);
    });

    test("with cursor pagination counts an input subquery", () => {
      const { statement, values } = getSql(Author, "count", {
        cursor: { id: "author-1" },
        skip: 1,
        take: 2,
      });

      expect(statement).toContain("COUNT");
      expect(statement).toContain("FROM (SELECT");
      expect(statement).toContain("aggregate_input");
      expect(statement).toContain("ORDER BY");
      expect(statement).toContain("LIMIT");
      expect(statement).toContain("OFFSET");
      expect(values).toContain("author-1");
      expect(values).toContain(2);
      expect(values).toContain(1);
    });

    test("with supported relation order counts an input subquery", () => {
      const { statement } = getSql(Post, "count", {
        orderBy: { author: { name: "asc" } },
        take: 1,
      });

      expect(statement).toContain("FROM (SELECT");
      expect(statement).toMatch(LEFT_JOIN_SQL);
      expect(statement).toContain('ORDER BY "t1"."name" ASC');
      expect(statement).toContain("LIMIT");
    });

    test("with unsupported relation order fails closed", () => {
      expect(() =>
        getSql(Author, "count", {
          orderBy: { posts: { title: "asc" } },
          take: 1,
        })
      ).toThrow();
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

      expect(statement).toContain("SUM");
      expect(statement).toContain("AVG");
      expect(statement).toContain("MIN");
      expect(statement).toContain("MAX");
    });

    test("with order and pagination aggregates an input subquery", () => {
      const { statement, values } = getSql(Post, "aggregate", {
        _count: true,
        _sum: { views: true },
        orderBy: { views: "desc" },
        take: 1,
        skip: 1,
      });

      expect(statement).toContain("COUNT");
      expect(statement).toContain("SUM");
      expect(statement).toContain("FROM (SELECT");
      expect(statement).toContain("aggregate_input");
      expect(statement).toContain("ORDER BY");
      expect(statement).toContain("LIMIT");
      expect(statement).toContain("OFFSET");
      expect(values).toContain(1);
    });

    test("with supported relation order aggregates an input subquery", () => {
      const { statement } = getSql(Post, "aggregate", {
        _count: true,
        orderBy: { author: { name: "asc" } },
        take: 1,
      });

      expect(statement).toContain("FROM (SELECT");
      expect(statement).toMatch(LEFT_JOIN_SQL);
      expect(statement).toContain('ORDER BY "t1"."name" ASC');
      expect(statement).toContain("LIMIT");
    });

    test("with unsupported relation order fails closed", () => {
      expect(() =>
        getSql(Author, "aggregate", {
          _count: true,
          orderBy: { posts: { title: "asc" } },
          take: 1,
        })
      ).toThrow();
    });
  });

  describe("groupBy", () => {
    test("with aggregate having (_count)", () => {
      const { statement } = getSql(Post, "groupBy", {
        by: ["authorId"],
        _count: { id: true },
        having: {
          id: {
            _count: { gt: 5 },
          },
        },
      });

      expect(statement).toContain("GROUP BY");
      expect(statement).toContain("HAVING");
    });

    test("with multiple aggregates on same field", () => {
      const { statement, values } = getSql(Post, "groupBy", {
        by: ["authorId"],
        having: {
          views: {
            _avg: { gte: 10 },
            _sum: { lt: 100 },
          },
        },
      });

      expect(statement).toContain("GROUP BY");
      expect(statement).toContain("HAVING");
      expect(statement).toContain("AVG");
      expect(statement).toContain("SUM");
      expect(values).toContain(10);
      expect(values).toContain(100);
    });

    test("with multiple fields (aggregate having)", () => {
      const { statement, values } = getSql(Post, "groupBy", {
        by: ["authorId"],
        having: {
          id: { _count: { gt: 5 } },
          views: { _sum: { lte: 100 } },
        },
      });

      expect(statement).toContain("GROUP BY");
      expect(statement).toContain("HAVING");
      expect(statement).toContain("COUNT");
      expect(statement).toContain("SUM");
      expect(values).toContain(5);
      expect(values).toContain(100);
    });

    test("with direct value filter in having", () => {
      const { statement, values } = getSql(Post, "groupBy", {
        by: ["authorId"],
        having: {
          authorId: "author-1",
        },
      });

      expect(statement).toContain("GROUP BY");
      expect(statement).toContain("HAVING");
      expect(statement).toContain('"t0"."authorId" =');
      expect(values).toContain("author-1");
    });

    test("with direct object filter (equals)", () => {
      const { statement, values } = getSql(Post, "groupBy", {
        by: ["authorId"],
        having: {
          authorId: { equals: "author-1" },
        },
      });

      expect(statement).toContain("GROUP BY");
      expect(statement).toContain("HAVING");
      expect(statement).toContain('"t0"."authorId" =');
      expect(values).toContain("author-1");
    });

    test("with direct object filter (in)", () => {
      const { statement, values } = getSql(Post, "groupBy", {
        by: ["authorId"],
        having: {
          authorId: { in: ["author-1", "author-2"] },
        },
      });

      expect(statement).toContain("GROUP BY");
      expect(statement).toContain("HAVING");
      expect(statement).toContain("IN (");
      expect(values).toContain("author-1");
      expect(values).toContain("author-2");
    });

    test("with direct object filter (notIn)", () => {
      const { statement, values } = getSql(Post, "groupBy", {
        by: ["authorId"],
        having: {
          authorId: { notIn: ["author-1", "author-2"] },
        },
      });

      expect(statement).toContain("GROUP BY");
      expect(statement).toContain("HAVING");
      expect(statement).toContain("NOT IN (");
      expect(values).toContain("author-1");
      expect(values).toContain("author-2");
    });

    test("with mixed aggregate and direct filters", () => {
      const { statement, values } = getSql(Post, "groupBy", {
        by: ["authorId"],
        having: {
          id: { _count: { gt: 5 } },
          authorId: "author-1",
        },
      });

      expect(statement).toContain("GROUP BY");
      expect(statement).toContain("HAVING");
      expect(statement).toContain("COUNT");
      expect(statement).toContain('"t0"."authorId" =');
      expect(statement).toContain("AND");
      expect(values).toContain(5);
      expect(values).toContain("author-1");
    });

    test("throws when direct having filter field is not in by", () => {
      expect(() =>
        getSql(Post, "groupBy", {
          by: ["authorId"],
          having: {
            title: { equals: "Hello" },
          },
        })
      ).toThrow("must be included in 'by'");
    });
  });
});

// =============================================================================
// ASSEMBLE INNER QUERY HELPER TESTS
// =============================================================================

import { assembleInnerQuery } from "../../src/query-engine/builders";
import { sql } from "../../src/sql/sql";

describe("assembleInnerQuery helper", () => {
  const adapter = new PostgresAdapter();

  test("basic query: SELECT FROM WHERE", () => {
    const result = assembleInnerQuery(
      adapter,
      sql`"id", "name"`,
      sql`"users"`,
      undefined, // no joins
      sql`"active" = true`,
      undefined, // no order
      undefined, // no take
      undefined // no skip
    );

    const statement = result.toStatement();
    expect(statement).toBe(
      'SELECT "id", "name" FROM "users" WHERE "active" = true'
    );
  });

  test("with joins", () => {
    const result = assembleInnerQuery(
      adapter,
      sql`"u"."id", "p"."title"`,
      sql`"users" "u"`,
      [sql`JOIN "posts" "p" ON "p"."userId" = "u"."id"`],
      sql`1=1`,
      undefined,
      undefined,
      undefined
    );

    const statement = result.toStatement();
    expect(statement).toContain('JOIN "posts" "p"');
  });

  test("with ORDER BY", () => {
    const result = assembleInnerQuery(
      adapter,
      sql`*`,
      sql`"users"`,
      undefined,
      sql`1=1`,
      sql`"created_at" DESC`,
      undefined,
      undefined
    );

    const statement = result.toStatement();
    expect(statement).toContain('ORDER BY "created_at" DESC');
  });

  test("with LIMIT", () => {
    const result = assembleInnerQuery(
      adapter,
      sql`*`,
      sql`"users"`,
      undefined,
      sql`1=1`,
      undefined,
      10,
      undefined
    );

    const statement = result.toStatement();
    expect(statement).toContain("LIMIT");
    expect(result.values).toContain(10);
  });

  test("with OFFSET", () => {
    const result = assembleInnerQuery(
      adapter,
      sql`*`,
      sql`"users"`,
      undefined,
      sql`1=1`,
      undefined,
      undefined,
      20
    );

    const statement = result.toStatement();
    expect(statement).toContain("OFFSET");
    expect(result.values).toContain(20);
  });

  test("full query: SELECT FROM JOIN WHERE ORDER LIMIT OFFSET", () => {
    const result = assembleInnerQuery(
      adapter,
      sql`"u"."id", "u"."name"`,
      sql`"users" "u"`,
      [sql`LEFT JOIN "posts" "p" ON "p"."authorId" = "u"."id"`],
      sql`"u"."active" = true`,
      sql`"u"."name" ASC`,
      5,
      10
    );

    const statement = result.toStatement();

    expect(statement).toContain("SELECT");
    expect(statement).toContain("FROM");
    expect(statement).toContain("LEFT JOIN");
    expect(statement).toContain("WHERE");
    expect(statement).toContain("ORDER BY");
    expect(statement).toContain("LIMIT");
    expect(statement).toContain("OFFSET");
    expect(result.values).toContain(5);
    expect(result.values).toContain(10);
  });

  test("empty joins array is ignored", () => {
    const result = assembleInnerQuery(
      adapter,
      sql`*`,
      sql`"users"`,
      [], // empty joins
      sql`1=1`,
      undefined,
      undefined,
      undefined
    );

    const statement = result.toStatement();
    expect(statement).not.toContain("JOIN");
  });
});

describe("batch ref adapter SQL", () => {
  test("PostgreSQL adapter owns batch ref storage SQL", () => {
    const adapter = new PostgresAdapter();
    const batchId = "batch-a";

    expect(
      adapter.batchRefs
        .setup(batchId)
        .map((statement) => statement.toStatement("$n"))
    ).toEqual([
      'CREATE TEMP TABLE IF NOT EXISTS "__viborm_batch_refs" ("batch_id" TEXT NOT NULL, "ref_key" TEXT NOT NULL, "ref_value" TEXT, PRIMARY KEY ("batch_id", "ref_key")) ON COMMIT DROP',
    ]);
    expect(adapter.batchRefs.clear(batchId).toStatement("$n")).toBe(
      'DELETE FROM "__viborm_batch_refs" WHERE "batch_id" = $1'
    );
    expect(adapter.batchRefs.clear(batchId).values).toEqual([batchId]);
    expect(
      adapter.batchRefs.storeLastInsertId(batchId, "user_id").toStatement("$n")
    ).toBe(
      'INSERT INTO "__viborm_batch_refs" ("batch_id", "ref_key", "ref_value") VALUES ($1, $2, CAST((lastval()) AS TEXT)) ON CONFLICT ("batch_id", "ref_key") DO UPDATE SET "ref_value" = EXCLUDED."ref_value"'
    );
    expect(
      adapter.batchRefs.store(batchId, "answer", sql`40 + 2`).toStatement("$n")
    ).toBe(
      'INSERT INTO "__viborm_batch_refs" ("batch_id", "ref_key", "ref_value") VALUES ($1, $2, CAST((40 + 2) AS TEXT)) ON CONFLICT ("batch_id", "ref_key") DO UPDATE SET "ref_value" = EXCLUDED."ref_value"'
    );
    expect(adapter.batchRefs.read(batchId, "answer").toStatement("$n")).toBe(
      '(SELECT "ref_value" FROM "__viborm_batch_refs" WHERE "batch_id" = $1 AND "ref_key" = $2 LIMIT 1)'
    );
    expect(adapter.batchRefs.cleanup(batchId).toStatement("$n")).toBe(
      'DELETE FROM "__viborm_batch_refs" WHERE "batch_id" = $1'
    );
  });

  test("SQLite adapter owns batch ref storage SQL", () => {
    const adapter = new SQLiteAdapter();
    const batchId = "batch-a";

    expect(
      adapter.batchRefs
        .setup(batchId)
        .map((statement) => statement.toStatement())
    ).toEqual([
      'CREATE TEMP TABLE IF NOT EXISTS "__viborm_batch_refs" ("batch_id" TEXT NOT NULL, "ref_key" TEXT NOT NULL, "ref_value" TEXT, PRIMARY KEY ("batch_id", "ref_key"))',
    ]);
    expect(adapter.batchRefs.clear(batchId).toStatement()).toBe(
      'DELETE FROM "__viborm_batch_refs" WHERE "batch_id" = ?'
    );
    expect(adapter.batchRefs.clear(batchId).values).toEqual([batchId]);
    expect(
      adapter.batchRefs.storeLastInsertId(batchId, "user_id").toStatement()
    ).toBe(
      'INSERT INTO "__viborm_batch_refs" ("batch_id", "ref_key", "ref_value") VALUES (?, ?, CAST((last_insert_rowid()) AS TEXT)) ON CONFLICT ("batch_id", "ref_key") DO UPDATE SET "ref_value" = EXCLUDED."ref_value"'
    );
    expect(
      adapter.batchRefs.store(batchId, "answer", sql`40 + 2`).toStatement()
    ).toBe(
      'INSERT INTO "__viborm_batch_refs" ("batch_id", "ref_key", "ref_value") VALUES (?, ?, CAST((40 + 2) AS TEXT)) ON CONFLICT ("batch_id", "ref_key") DO UPDATE SET "ref_value" = EXCLUDED."ref_value"'
    );
    expect(adapter.batchRefs.read(batchId, "answer").toStatement()).toBe(
      '(SELECT "ref_value" FROM "__viborm_batch_refs" WHERE "batch_id" = ? AND "ref_key" = ? LIMIT 1)'
    );
    expect(adapter.batchRefs.cleanup(batchId).toStatement()).toBe(
      'DELETE FROM "__viborm_batch_refs" WHERE "batch_id" = ?'
    );
  });
});

// =============================================================================
// EXPLICIT UNDEFINED ARGS (Prisma parity)
// =============================================================================

describe("explicit undefined args behave like absent args", () => {
  test("findMany with { where: undefined } matches {}", () => {
    const explicit = getSql(Author, "findMany", { where: undefined });
    const absent = getSql(Author, "findMany", {});
    expect(explicit.statement).toBe(absent.statement);
    expect(explicit.values).toEqual(absent.values);
  });

  test("findMany with undefined where field matches omitting it", () => {
    const explicit = getSql(Author, "findMany", {
      where: { name: undefined, email: "a@x.com" },
    });
    const absent = getSql(Author, "findMany", {
      where: { email: "a@x.com" },
    });
    expect(explicit.statement).toBe(absent.statement);
    expect(explicit.values).toEqual(absent.values);
  });

  test("findMany with undefined select/orderBy/take matches {}", () => {
    const explicit = getSql(Author, "findMany", {
      select: undefined,
      orderBy: undefined,
      take: undefined,
    });
    const absent = getSql(Author, "findMany", {});
    expect(explicit.statement).toBe(absent.statement);
  });

  test("update with undefined data field does not touch the column", () => {
    const explicit = getSql(Author, "update", {
      where: { id: "1" },
      data: { name: undefined, email: "b@x.com" },
    });
    const absent = getSql(Author, "update", {
      where: { id: "1" },
      data: { email: "b@x.com" },
    });
    expect(explicit.statement).toBe(absent.statement);
    expect(explicit.values).toEqual(absent.values);
  });

  test("relation count with { where: undefined } matches plain count", () => {
    const explicit = getSql(Author, "findMany", {
      select: { id: true, _count: { select: { posts: { where: undefined } } } },
    });
    const absent = getSql(Author, "findMany", {
      select: { id: true, _count: { select: { posts: true } } },
    });
    expect(explicit.statement).toBe(absent.statement);
  });
});
