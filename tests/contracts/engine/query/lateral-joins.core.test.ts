/**
 * Lateral Joins Tests
 *
 * Tests the lateral join feature for nested includes.
 * Verifies:
 * - PostgreSQL and MySQL use lateral joins when capability is enabled
 * - SQLite falls back to correlated subqueries
 * - SQL output matches expected patterns
 */

import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import { sql } from "@sql";
import { SqlOnlyDriver } from "@tests/fixtures/drivers/sql-only";
import { createSchemaRegistry } from "@validation";
import { beforeAll, describe, expect, test } from "vitest";

const PARAMETERIZED_LIMIT_SQL = /LIMIT \$\d+/;

// =============================================================================
// TEST MODELS
// =============================================================================

const Author = s.model({
  id: s.string().id(),
  name: s.string(),
  email: s.string().unique(),
  posts: s.toMany(() => Post),
});

const Post = s
  .model({
    id: s.string().id(),
    title: s.string(),
    content: s.string().nullable(),
    authorId: s.string(),
    author: s
      .toOne(() => Author)
      .fields("authorId")
      .references("id"),
  })
  .map("posts");

const schema = { Author, Post };

// Hydrate schema names before tests
hydrateSchemaNames(schema);

// =============================================================================
// ADAPTERS AND SQL-ONLY DRIVERS
// =============================================================================

const postgresAdapter = new PostgresAdapter();
const mysqlAdapter = new MySQLAdapter();
const sqliteAdapter = new SQLiteAdapter();

const postgresMockDriver = new SqlOnlyDriver(postgresAdapter, "postgresql");
const mysqlMockDriver = new SqlOnlyDriver(mysqlAdapter, "mysql");
const sqliteMockDriver = new SqlOnlyDriver(sqliteAdapter, "sqlite");

// =============================================================================
// ADAPTER CAPABILITIES TESTS
// =============================================================================

describe("Lateral Joins", () => {
  describe("Adapter Capabilities", () => {
    test("PostgreSQL adapter supports lateral joins", () => {
      expect(postgresAdapter.capabilities.supportsLateralJoins).toBe(true);
    });

    test("MySQL adapter supports lateral joins", () => {
      expect(mysqlAdapter.capabilities.supportsLateralJoins).toBe(true);
    });

    test("SQLite adapter does not support lateral joins", () => {
      expect(sqliteAdapter.capabilities.supportsLateralJoins).toBe(false);
    });
  });

  describe("Adapter Join Methods", () => {
    describe("PostgreSQL lateral join methods", () => {
      test("lateral() generates correct SQL", () => {
        const subquery = sql`SELECT 1 AS result`;
        const result = postgresAdapter.joins.lateral(subquery, "t1");
        const text = result.toStatement("$n");

        expect(text).toContain("JOIN LATERAL");
        expect(text).toContain("ON TRUE");
        expect(text).toContain('"t1"');
      });

      test("lateralLeft() generates correct SQL", () => {
        const subquery = sql`SELECT 1 AS result`;
        const result = postgresAdapter.joins.lateralLeft(subquery, "t1");
        const text = result.toStatement("$n");

        expect(text).toContain("LEFT JOIN LATERAL");
        expect(text).toContain("ON TRUE");
        expect(text).toContain('"t1"');
      });
    });

    describe("MySQL lateral join methods", () => {
      test("lateral() generates correct SQL", () => {
        const subquery = sql`SELECT 1 AS result`;
        const result = mysqlAdapter.joins.lateral(subquery, "t1");
        const text = result.toStatement("?");

        expect(text).toContain("JOIN LATERAL");
        expect(text).toContain("ON TRUE");
        expect(text).toContain("`t1`");
      });

      test("lateralLeft() generates correct SQL", () => {
        const subquery = sql`SELECT 1 AS result`;
        const result = mysqlAdapter.joins.lateralLeft(subquery, "t1");
        const text = result.toStatement("?");

        expect(text).toContain("LEFT JOIN LATERAL");
        expect(text).toContain("ON TRUE");
        expect(text).toContain("`t1`");
      });
    });

    describe("SQLite lateral join methods", () => {
      test("lateral() throws error", () => {
        const subquery = sql`SELECT 1 AS result`;
        expect(() => sqliteAdapter.joins.lateral(subquery, "t1")).toThrow(
          "SQLite does not support LATERAL joins"
        );
      });

      test("lateralLeft() throws error", () => {
        const subquery = sql`SELECT 1 AS result`;
        expect(() => sqliteAdapter.joins.lateralLeft(subquery, "t1")).toThrow(
          "SQLite does not support LATERAL joins"
        );
      });
    });
  });

  describe("SQL Generation", () => {
    let registry: ReturnType<typeof createModelRegistry>;

    beforeAll(() => {
      const schema = { Author, Post };
      registry = createModelRegistry(schema, createSchemaRegistry(schema));
    });

    describe("PostgreSQL (lateral joins enabled)", () => {
      let engine: QueryEngine;

      beforeAll(() => {
        engine = new QueryEngine(postgresMockDriver, registry);
      });

      test("to-many include uses lateral join", () => {
        const result = engine.build(Author, "findMany", {
          include: { posts: true },
        });
        const statement = result.toStatement("$n");

        // Should use lateral join syntax
        expect(statement).toContain("LEFT JOIN LATERAL");
        expect(statement).toContain("ON TRUE");
        // Should have JSON aggregation in the lateral subquery
        expect(statement).toContain("json_agg");
      });

      test("to-one include uses lateral join", () => {
        const result = engine.build(Post, "findMany", {
          include: { author: true },
        });
        const statement = result.toStatement("$n");

        // Should use lateral join syntax
        expect(statement).toContain("LEFT JOIN LATERAL");
        expect(statement).toContain("ON TRUE");
        // LIMIT is parameterized (LIMIT $1, $2, etc.)
        expect(statement).toMatch(PARAMETERIZED_LIMIT_SQL);
      });

      test("include with where filter", () => {
        const result = engine.build(Author, "findMany", {
          include: {
            posts: {
              where: { title: { contains: "test" } },
            },
          },
        });
        const statement = result.toStatement("$n");

        expect(statement).toContain("LEFT JOIN LATERAL");
        expect(statement).toContain("POSITION");
      });

      test("include with orderBy", () => {
        const result = engine.build(Author, "findMany", {
          include: {
            posts: {
              orderBy: { title: "desc" },
            },
          },
        });
        const statement = result.toStatement("$n");

        expect(statement).toContain("LEFT JOIN LATERAL");
        expect(statement).toContain("ORDER BY");
        expect(statement).toContain("DESC");
      });

      test("include with take/skip pagination", () => {
        const result = engine.build(Author, "findMany", {
          include: {
            posts: {
              take: 5,
              skip: 10,
            },
          },
        });
        const statement = result.toStatement("$n");

        expect(statement).toContain("LEFT JOIN LATERAL");
        expect(statement).toContain("LIMIT");
        expect(statement).toContain("OFFSET");
      });
    });

    describe("SQLite (correlated subquery fallback)", () => {
      let engine: QueryEngine;

      beforeAll(() => {
        engine = new QueryEngine(sqliteMockDriver, registry);
      });

      test("to-many include uses correlated subquery (no lateral)", () => {
        const result = engine.build(Author, "findMany", {
          include: { posts: true },
        });
        const statement = result.toStatement("?");

        // Should NOT use lateral join syntax
        expect(statement).not.toContain("LATERAL");
        // Should use scalar subquery pattern
        expect(statement).toContain("json_group_array");
        expect(statement).toContain("(SELECT");
      });

      test("to-one include uses correlated subquery (no lateral)", () => {
        const result = engine.build(Post, "findMany", {
          include: { author: true },
        });
        const statement = result.toStatement("?");

        // Should NOT use lateral join syntax
        expect(statement).not.toContain("LATERAL");
        // Should use scalar subquery pattern
        expect(statement).toContain("(SELECT");
        // LIMIT is parameterized (LIMIT ?)
        expect(statement).toContain("LIMIT ?");
      });
    });

    describe("MySQL (lateral joins enabled)", () => {
      let engine: QueryEngine;

      beforeAll(() => {
        engine = new QueryEngine(mysqlMockDriver, registry);
      });

      test("to-many include uses lateral join", () => {
        const result = engine.build(Author, "findMany", {
          include: { posts: true },
        });
        const statement = result.toStatement("?");

        // Should use lateral join syntax
        expect(statement).toContain("LEFT JOIN LATERAL");
        expect(statement).toContain("ON TRUE");
        // Should have JSON aggregation in the lateral subquery
        expect(statement).toContain("JSON_ARRAYAGG");
      });

      test("to-one include uses lateral join", () => {
        const result = engine.build(Post, "findMany", {
          include: { author: true },
        });
        const statement = result.toStatement("?");

        // Should use lateral join syntax
        expect(statement).toContain("LEFT JOIN LATERAL");
        expect(statement).toContain("ON TRUE");
        // MySQL inlines integer LIMIT values (mysql2 binds numbers as DOUBLE,
        // which MySQL rejects for LIMIT)
        expect(statement).toContain("LIMIT 1");
      });
    });
  });
});
