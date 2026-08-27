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
import { getTableName } from "@query-engine/context";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { s } from "@schema";
import { sqlGenerationUserPostSchema } from "@tests/fixtures/user-post-schema";
import { createSchemaRegistry } from "@validation";
import { beforeAll, describe, expect, test } from "vitest";

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
      publishers: s.toMany(() => Publisher),
    })
    .map("nested_order_countries");

  const Publisher = s
    .model({
      id: s.string().id(),
      name: s.string(),
      rank: s.int(),
      countryId: s.string(),
      country: s
        .toOne(() => Country)
        .fields("countryId")
        .references("id"),
      authors: s.toMany(() => Author),
    })
    .map("nested_order_publishers");

  const Author = s
    .model({
      id: s.string().id(),
      name: s.string(),
      publisherId: s.string(),
      publisher: s
        .toOne(() => Publisher)
        .fields("publisherId")
        .references("id"),
      posts: s.toMany(() => NestedPost),
    })
    .map("nested_order_authors");

  const NestedPost = s
    .model({
      id: s.string().id(),
      title: s.string(),
      authorId: s.string(),
      author: s
        .toOne(() => Author)
        .fields("authorId")
        .references("id"),
      comments: s.toMany(() => Comment),
    })
    .map("nested_order_posts");

  const Comment = s
    .model({
      id: s.string().id(),
      text: s.string(),
      postId: s.string(),
      post: s
        .toOne(() => NestedPost)
        .fields("postId")
        .references("id"),
    })
    .map("nested_order_comments");

  // Self-referential to-one chain: the only way to build an orderBy path
  // deeper than MAX_RELATION_ORDER_DEPTH (8) without eight more models.
  const Link = s
    .model({
      id: s.string().id(),
      label: s.string(),
      nextId: s.string().nullable(),
      next: s
        .toOne(() => Link)
        .fields("nextId")
        .references("id"),
      previous: s.toMany(() => Link),
    })
    .map("nested_order_links");

  return { Country, Publisher, Author, NestedPost, Comment, Link };
})();

/** `{ next: { next: … { label: "asc" } } }` with `hops` `next` levels. */
function linkChainOrderBy(hops: number): Record<string, unknown> {
  let chain: Record<string, unknown> = { label: "asc" };
  for (let i = 0; i < hops; i++) {
    chain = { next: chain };
  }
  return chain;
}

// =============================================================================
// TEST SETUP
// =============================================================================

const schema = sqlGenerationUserPostSchema;

// Hydrate schema names before tests
prepareSchema(schema);

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
/** An engine over the schema that holds the file's one OPTIONAL to-one slot. */
let optionalEngine: QueryEngine;

beforeAll(() => {
  registry = createModelRegistry(schema, createSchemaRegistry(schema));
  engine = new QueryEngine(mockDriver, registry);
  prepareSchema(nestedRelationOrderBySchema);
  optionalEngine = new QueryEngine(
    mockDriver,
    createModelRegistry(
      nestedRelationOrderBySchema,
      createSchemaRegistry(nestedRelationOrderBySchema)
    )
  );
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
  const ctx = scopeFor(adapter, model);
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

    test("json string paths compile to the same SQL as the array form", () => {
      // The string form is pure sugar: it is parsed into the array form
      // before any adapter sees it, so statement AND bound values match
      const fromString = getSql(Author, "findMany", {
        where: {
          metadata: { path: "$.pet.toys[0]", string_contains: "ball" },
        },
      });
      const fromArray = getSql(Author, "findMany", {
        where: {
          metadata: {
            path: ["pet", "toys", "0"],
            string_contains: "ball",
          },
        },
      });

      expect(fromString.statement).toBe(fromArray.statement);
      expect(fromString.values).toEqual(fromArray.values);
      expect(fromString.values).toContainEqual(["pet", "toys", "0"]);
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
        'LEFT JOIN "public"."nested_order_authors" AS "t1" ON "t0"."authorId" = "t1"."id"'
      );
      expect(joins[1]).toContain(
        'LEFT JOIN "public"."nested_order_publishers" AS "t2" ON "t1"."publisherId" = "t2"."id"'
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
        'LEFT JOIN "public"."nested_order_posts" AS "t1" ON "t0"."postId" = "t1"."id"'
      );
      expect(joins[1]).toContain(
        'LEFT JOIN "public"."nested_order_authors" AS "t2" ON "t1"."authorId" = "t2"."id"'
      );
      expect(joins[2]).toContain(
        'LEFT JOIN "public"."nested_order_publishers" AS "t3" ON "t2"."publisherId" = "t3"."id"'
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

    test("builder accepts a four-hop to-one relation orderBy", () => {
      // Was the over-cap case while MAX_RELATION_ORDER_DEPTH was 3; decision
      // D-5 raised the cap to 8, so this chain is now legal.
      const parts = getWhiteBoxOrderByParts(
        nestedRelationOrderBySchema.Comment,
        {
          post: {
            author: {
              publisher: {
                country: {
                  name: "asc",
                },
              },
            },
          },
        }
      );

      expect(parts.joins).toHaveLength(4);
      expect(parts.orderBy?.toStatement("$n")).toBe('"t4"."name" ASC');
    });

    test("builder accepts a to-one relation orderBy at the depth cap", () => {
      const parts = getWhiteBoxOrderByParts(
        nestedRelationOrderBySchema.Link,
        linkChainOrderBy(8)
      );

      expect(parts.joins).toHaveLength(8);
      expect(parts.orderBy?.toStatement("$n")).toBe('"t8"."label" ASC');
    });

    test("builder rejects relation orderBy past the depth cap", () => {
      expect(() =>
        getWhiteBoxOrderByParts(
          nestedRelationOrderBySchema.Link,
          linkChainOrderBy(9)
        )
      ).toThrow(
        "Relation orderBy path 'next.next.next.next.next.next.next.next.next' exceeds maximum depth of 8 relation hops."
      );
    });

    test("to-many relation _count orderBy uses count subquery", () => {
      const { statement } = getSql(Author, "findMany", {
        orderBy: { posts: { _count: "desc" } },
      });

      expect(statement).not.toMatch(LEFT_JOIN_SQL);
      expect(statement).toMatch(ORDER_BY_COUNT_SQL);
      expect(statement).toContain('FROM "public"."posts" AS "t1"');
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
      const ctx = scopeFor(adapter, Author);

      expect(() =>
        buildWhere(ctx, { age: { unsupported: 1 } }, ctx.rootAlias)
      ).toThrow(
        "Unsupported filter operation 'unsupported' for int scalar 'age'"
      );
    });

    test("unknown builder where field fails closed", () => {
      const ctx = scopeFor(adapter, Author);

      expect(() =>
        buildWhere(ctx, { unknownField: { equals: "value" } }, ctx.rootAlias)
      ).toThrow("Unknown where field 'unknownField'");
    });

    test("empty unique builder fails closed", () => {
      const ctx = scopeFor(adapter, Author);

      expect(() => buildWhereUnique(ctx, {}, ctx.rootAlias)).toThrow(
        "whereUnique requires at least one unique discriminator"
      );
    });

    // W4-U1 retarget: a non-unique scalar in a unique `where` is no longer a
    // rejected KEY — it is the extended `where`'s filter half (Prisma >= 4.5),
    // which compiles alongside the discriminator. What stayed is the rule that
    // makes the selector a selector: without a discriminator there is nothing to
    // narrow, and the builder still refuses to emit a filter-only "unique" read.
    test("a filter-only unique builder input fails closed", () => {
      const ctx = scopeFor(adapter, Author);

      expect(() =>
        buildWhereUnique(ctx, { name: { equals: "Alice" } }, ctx.rootAlias)
      ).toThrow("whereUnique requires at least one unique discriminator");
    });

    test("an unknown field in the filter half still fails closed", () => {
      const ctx = scopeFor(adapter, Author);

      expect(() =>
        buildWhereUnique(
          ctx,
          { id: "author-1", unknownField: { equals: "x" } },
          ctx.rootAlias
        )
      ).toThrow("Unknown where field 'unknownField'");
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
    // PIN UPDATED DELIBERATELY — query-performance-plan Phase 3 (the delete fold).
    //
    // This pin previously asserted that `build()` REJECTS a root delete, because a
    // root delete located the row by its unique `where` (a notFound-enforcing
    // planning read), re-read its shape, and only then deleted it: three statements,
    // five round trips. Phase 3 folds the mainstream shape — a scalar-projected
    // delete on a RETURNING driver — into ONE `DELETE … RETURNING`, so the
    // single-statement `build()` API now answers it. The old assertion pinned the
    // round-trip count this phase exists to remove; the two tests below pin what
    // replaced it, on both sides of the fold gate.
    test("a scalar delete on a RETURNING driver is ONE statement", () => {
      const { statement, values } = getSql(Author, "delete", {
        where: { id: "author-1" },
      });

      expect(statement).toContain("DELETE");
      expect(statement).toContain("RETURNING");
      expect(values).toContain("author-1");
    });

    test("a non-returning driver keeps the multi-step path", () => {
      // MySQL cannot hand the deleted row back, and after the DELETE there is
      // nothing left to read — so the row is read BEFORE it is removed and the
      // operation stays multi-statement, which `build()` still rejects. The same
      // capability boundary `non-returning-delete-plan.test.ts` pins for
      // `deleteMany` + `select`.
      const mysqlEngine = new QueryEngine(
        new MockDriver(new MySQLAdapter(), "mysql"),
        registry
      );

      expect(() =>
        mysqlEngine.build(Author, "delete", { where: { id: "author-1" } })
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
  });

  /**
   * §9.4 — the null form of a to-one filter exists exactly where the SLOT MAY BE
   * EMPTY, which is a fact of the stored tuple. `Post.author`'s foreign key is
   * non-nullable, so there is no second optionality flag left to disagree with
   * the column and the null form is refused; `Link.next`'s is nullable, so it
   * keeps the `IS NULL` lowering.
   */
  describe("null checks on a to-one", () => {
    const linkSql = (where: Record<string, unknown>) =>
      optionalEngine
        .build(nestedRelationOrderBySchema.Link, "findMany", { where })
        .toStatement("$n");

    test("a required slot refuses the null form", () => {
      expect(() =>
        getSql(Post, "findMany", { where: { author: { is: null } } })
      ).toThrow(ValidationError);
      expect(() =>
        getSql(Post, "findMany", { where: { author: { isNot: null } } })
      ).toThrow(ValidationError);
    });

    test("is null", () => {
      expect(linkSql({ next: { is: null } })).toMatch(IS_NULL_REGEX);
    });

    test("isNot null", () => {
      expect(linkSql({ next: { isNot: null } })).toMatch(IS_NOT_NULL_REGEX);
    });

    test("combines null and object forms", () => {
      const isNull = linkSql({
        next: { is: null, isNot: { label: "a" } },
      });
      const isNotNull = linkSql({
        next: { is: { label: "a" }, isNot: null },
      });

      expect(isNull).toMatch(IS_NULL_REGEX);
      expect(isNull).toContain("NOT EXISTS");
      expect(isNull).toContain(" AND ");
      expect(isNotNull).toContain("EXISTS");
      expect(isNotNull).toMatch(IS_NOT_NULL_REGEX);
      expect(isNotNull).toContain(" AND ");
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

    // PINS FLIPPED DELIBERATELY — query-performance-plan Phase 8.2. These two
    // shapes DID reject the single-statement build API, because a nested create
    // tree was one INSERT per node plus a terminal read. On PostgreSQL a
    // guard-free tree whose keys are all literals is now one command: the root
    // INSERT returning every column, one `WITH` arm per child write, and the
    // scalar projection selected off the root arm. `build()` therefore has a
    // statement to hand back, and saying so is the point of the phase.
    //
    // The three shapes around them still reject, and each for its own reason —
    // which is what keeps these from being a blanket "creates are one statement
    // now": a `connect` probes first (below), a relation `select` cannot read
    // what a sibling arm just wrote (the list case), and TWO database-assigned
    // keys are two `nextval`s whose order across unread `WITH` arms PostgreSQL
    // does not specify (`mutation-projection-cte-fold.test.ts`). Package M
    // amended the third: ONE database-generated parent key is now a value an arm
    // CAN pass to another, lowered to a CTE column
    // (`mutation-dependency-fold.test.ts`).
    test("create with nested create builds ONE folded statement", () => {
      const { statement } = getSql(Author, "create", {
        data: {
          id: "author-1",
          name: "Alice",
          email: "alice@example.com",
          posts: {
            create: { id: "post-1", title: "First Post" },
          },
        },
      });

      expect(statement).toContain('WITH "__viborm_mutation" AS (INSERT');
      expect(statement).toContain('"__viborm_write_0" AS (INSERT');
      expect(statement).toContain('FROM "__viborm_mutation"');
    });

    test("create with nested createMany builds ONE folded statement", () => {
      const { statement } = getSql(Author, "create", {
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
      });

      expect(statement).toContain('WITH "__viborm_mutation" AS (INSERT');
      expect(statement).toContain('"__viborm_write_0" AS (INSERT');
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

    // §8.4 / D27 — the refusal MOVED. HEAD published `disconnect` from a
    // declared `.optional()` and let an engine guard close a non-nullable
    // column; the verb is now published from `membershipCanBeCleared`, the same
    // owner the engine clears from, so a required slot never spells it and the
    // operation schema is where the refusal lands.
    test("a required relation publishes no disconnect at all", () => {
      expect(() =>
        getSql(Post, "update", {
          where: { id: "post-1" },
          data: {
            author: {
              disconnect: true,
            },
          },
        })
      ).toThrow(ValidationError);
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

import { assembleInnerQuery } from "@src/query-engine/builders/include-query";
import { sql } from "@src/sql/sql";
import { prepareSchema, scopeFor } from "@tests/fixtures/query-scope";

describe("assembleInnerQuery helper", () => {
  const adapter = new PostgresAdapter();

  test("basic query: SELECT FROM WHERE", () => {
    const result = assembleInnerQuery(adapter, {
      selectExpr: sql`"id", "name"`,
      from: sql`"users"`,
      where: sql`"active" = true`,
    });

    const statement = result.toStatement();
    expect(statement).toBe(
      'SELECT "id", "name" FROM "users" WHERE "active" = true'
    );
  });

  test("with joins", () => {
    const result = assembleInnerQuery(adapter, {
      selectExpr: sql`"u"."id", "p"."title"`,
      from: sql`"users" "u"`,
      joins: [sql`JOIN "posts" "p" ON "p"."userId" = "u"."id"`],
      where: sql`1=1`,
    });

    const statement = result.toStatement();
    expect(statement).toContain('JOIN "posts" "p"');
  });

  test("with ORDER BY", () => {
    const result = assembleInnerQuery(adapter, {
      selectExpr: sql`*`,
      from: sql`"users"`,
      where: sql`1=1`,
      orderBy: sql`"created_at" DESC`,
    });

    const statement = result.toStatement();
    expect(statement).toContain('ORDER BY "created_at" DESC');
  });

  test("with LIMIT", () => {
    const result = assembleInnerQuery(adapter, {
      selectExpr: sql`*`,
      from: sql`"users"`,
      where: sql`1=1`,
      take: 10,
    });

    const statement = result.toStatement();
    expect(statement).toContain("LIMIT");
    expect(result.values).toContain(10);
  });

  test("with OFFSET", () => {
    const result = assembleInnerQuery(adapter, {
      selectExpr: sql`*`,
      from: sql`"users"`,
      where: sql`1=1`,
      skip: 20,
    });

    const statement = result.toStatement();
    expect(statement).toContain("OFFSET");
    expect(result.values).toContain(20);
  });

  test("full query: SELECT FROM JOIN WHERE ORDER LIMIT OFFSET", () => {
    const result = assembleInnerQuery(adapter, {
      selectExpr: sql`"u"."id", "u"."name"`,
      from: sql`"users" "u"`,
      joins: [sql`LEFT JOIN "posts" "p" ON "p"."authorId" = "u"."id"`],
      where: sql`"u"."active" = true`,
      orderBy: sql`"u"."name" ASC`,
      take: 5,
      skip: 10,
    });

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
    const result = assembleInnerQuery(adapter, {
      selectExpr: sql`*`,
      from: sql`"users"`,
      joins: [], // empty joins
      where: sql`1=1`,
    });

    const statement = result.toStatement();
    expect(statement).not.toContain("JOIN");
  });

  test("distinct without an order uses PostgreSQL's DISTINCT ON", () => {
    const result = assembleInnerQuery(adapter, {
      selectExpr: sql`"payload" AS "_json"`,
      from: sql`"posts" "t1"`,
      where: sql`1=1`,
      distinct: sql`"t1"."topic"`,
      distinctColumnAliases: ["_json"],
    });

    expect(result.toStatement()).toContain('DISTINCT ON ("t1"."topic")');
  });

  test("distinct with an order uses the ROW_NUMBER partition emulation", () => {
    const result = assembleInnerQuery(adapter, {
      selectExpr: sql`"payload" AS "_json"`,
      from: sql`"posts" "t1"`,
      where: sql`1=1`,
      orderBy: sql`"t1"."id" ASC`,
      take: 2,
      distinct: sql`"t1"."topic"`,
      distinctColumnAliases: ["_json"],
    });

    const statement = result.toStatement();
    expect(statement).toContain('PARTITION BY "t1"."topic"');
    // the window applies to the deduplicated rows, not the raw ones
    expect(statement).toContain('SELECT "_json" FROM (');
    expect(statement).toContain('WHERE "_rn" = 1');
    expect(statement.indexOf("LIMIT")).toBeGreaterThan(
      statement.indexOf('"_rn" = 1')
    );
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
    expect(adapter.batchRefs.storeLastInsertId).toBeUndefined();
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
    const storeLastInsertId = adapter.batchRefs.storeLastInsertId;
    expect(storeLastInsertId).toBeDefined();
    expect(storeLastInsertId?.(batchId, "user_id").toStatement()).toBe(
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

  test("MySQL retains exact statement-local generated identity storage", () => {
    const adapter = new MySQLAdapter();
    const storeLastInsertId = adapter.batchRefs.storeLastInsertId;
    expect(storeLastInsertId).toBeDefined();
    expect(storeLastInsertId?.("batch-a", "user_id").toStatement()).toBe(
      "INSERT INTO `__viborm_batch_refs` (`batch_id`, `ref_key`, `ref_value`) VALUES (?, ?, CAST((LAST_INSERT_ID()) AS CHAR)) ON DUPLICATE KEY UPDATE `ref_value` = VALUES(`ref_value`)"
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
