import type { DatabaseAdapter } from "@adapters/database-adapter";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import type { Dialect } from "@drivers";
import { buildFindPagination } from "@query-engine/operations/find-pagination";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { s } from "@schema";
import { SqlOnlyDriver } from "@tests/fixtures/drivers/sql-only";
import { prepareSchema, scopeFor } from "@tests/fixtures/query-scope";
import { createSchemaRegistry } from "@validation";
import { beforeAll, describe, expect, test } from "vitest";

const User = s
  .model({
    alternate: s.string().unique(),
    id: s.string().id(),
    age: s.int().nullable(),
    posts: s.toMany(() => Post),
  })
  .map("cursor_sql_users");

const Post = s
  .model({
    id: s.string().id(),
    userId: s.string(),
    user: s
      .toOne(() => User)
      .fields("userId")
      .references("id"),
  })
  .map("cursor_sql_posts");

const VectorItem = s
  .model({
    id: s.string().id(),
    embedding: s.vector().dimension(3),
  })
  .map("cursor_sql_vectors");

const schema = { User, Post, VectorItem };

type DialectCase = {
  name: string;
  dialect: Dialect;
  quote: '"' | "`";
  createAdapter: () => DatabaseAdapter;
};

const dialectCases: DialectCase[] = [
  {
    name: "PostgreSQL",
    dialect: "postgresql",
    quote: '"',
    createAdapter: () => new PostgresAdapter(),
  },
  {
    name: "MySQL",
    dialect: "mysql",
    quote: "`",
    createAdapter: () => new MySQLAdapter(),
  },
  {
    name: "SQLite",
    dialect: "sqlite",
    quote: '"',
    createAdapter: () => new SQLiteAdapter(),
  },
];

beforeAll(() => prepareSchema(schema));

describe.each(dialectCases)("$name cursor SQL", (dialectCase) => {
  // --- Unit 5.2: the sargable cursor spelling -------------------------------
  // `alternate` and `id` are both NOT NULL, so the cursor comparison can be a
  // row value against a row-valued subquery, which a planner can turn into an
  // index range seek. `age` is nullable and keeps the general predicate.

  test("a backward window over an ascending order compares the other way", () => {
    // A negative take reverses every key, so an all-ascending order becomes an
    // all-descending one — still uniform, so still a row value, now `<=`.
    const { statement } = buildUserQuery(dialectCase, {
      cursor: { id: "cursor-id" },
      orderBy: { alternate: "asc" },
      take: -2,
    });

    expect(statement).toContain(") <= (SELECT");
    expect(statement).not.toContain("EXISTS");
  });

  test("a descending order keeps the null-guarded predicate", () => {
    const { statement } = buildUserQuery(dialectCase, {
      cursor: { id: "cursor-id" },
      orderBy: { alternate: "desc" },
      take: 2,
    });

    // `normalizeCursorOrder` always appends the identity tie-breaker
    // ascending, so a descending sort produces `alternate DESC, id ASC` — a
    // mixed order, which no row value spells. The spelling is chosen from the
    // normalized order, not from the requested one.
    expect(statement).toContain("ORDER BY");
    expect(statement).toContain("EXISTS");
    expect(statement).not.toContain(") <= (SELECT");
  });

  test("mixed sort directions keep the null-guarded predicate", () => {
    const { statement } = buildUserQuery(dialectCase, {
      cursor: { id: "cursor-id" },
      orderBy: [{ alternate: "asc" }, { id: "desc" }],
      take: 2,
    });

    // `(a, b) > (x, y)` means `a > x OR (a = x AND b > y)`; it cannot spell
    // an ascending key followed by a descending one.
    expect(statement).toContain("EXISTS");
    expect(statement).not.toContain(") >= (SELECT");
    expect(statement).not.toContain(") <= (SELECT");
  });

  test("relation cursor ordering fails explicitly", () => {
    const engine = createEngine(dialectCase);

    expect(() =>
      engine.build(User, "findMany", {
        cursor: { id: "cursor-id" },
        orderBy: { posts: { _count: "asc" } },
        take: 2,
      })
    ).toThrow("Cursor pagination supports direct scalar sort directions only");
  });
});

describe("find pagination fallback planning", () => {
  test("reverses every nested fallback item without interpreting its shape", () => {
    const plan = buildFindPagination(
      scopeFor(new PostgresAdapter(), User),
      {
        orderBy: [
          { posts: { _count: "asc" } },
          {
            posts: {
              rank: { sort: "desc", nulls: "first" },
              opaque: 7,
            },
          },
        ],
      },
      -2,
      "t0"
    );

    expect(plan.normalizedOrder).toBeUndefined();
    expect(plan.cursorCondition).toBeUndefined();
    expect(plan.orderBy).toEqual([
      { posts: { _count: "desc" } },
      {
        posts: {
          rank: { sort: "asc", nulls: "last" },
          opaque: 7,
        },
      },
    ]);
  });

  describe("coverage low value: validated pagination numbers", () => {
    test("fails closed when called below the public validation boundary", () => {
      const scope = scopeFor(new PostgresAdapter(), User);

      expect(() => buildFindPagination(scope, {}, 1.5, "t0")).toThrow(
        "Pagination take must be an integer"
      );
      expect(() =>
        buildFindPagination(scope, { skip: 1.5 }, undefined, "t0")
      ).toThrow("Pagination skip must be an integer");
      expect(() =>
        buildFindPagination(scope, { skip: -1 }, undefined, "t0")
      ).toThrow("Pagination skip must be greater than or equal to 0");
    });
  });
});

function createEngine(dialectCase: DialectCase): QueryEngine {
  const adapter = dialectCase.createAdapter();
  const registry = createModelRegistry(schema, createSchemaRegistry(schema));
  return new QueryEngine(
    new SqlOnlyDriver(adapter, dialectCase.dialect),
    registry
  );
}

function buildUserQuery(
  dialectCase: DialectCase,
  args: Record<string, unknown>
): { statement: string; values: unknown[] } {
  const query = createEngine(dialectCase).build(User, "findMany", args);
  return {
    statement: query.toStatement("$n"),
    values: query.values,
  };
}
