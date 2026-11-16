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
import { hydrateSchemaNames, s } from "@schema";
import { sql } from "@sql";
import { SqlOnlyDriver } from "@tests/fixtures/drivers/sql-only";
import {
  createModelRegistry,
  TestQueryEngine,
} from "@tests/fixtures/query-engine";
import { createSchemaRegistry } from "@validation";
import { beforeAll, describe, expect, test } from "vitest";

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

    describe("SQLite (correlated subquery fallback)", () => {
      let engine: TestQueryEngine;

      beforeAll(() => {
        engine = new TestQueryEngine(sqliteMockDriver, registry);
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
  });
});

// A to-one relation on PostgreSQL is a LEFT JOIN LATERAL, where PostgreSQL
// caches the related row per key; a join between a sort and its bound would
// make the top-N sort a whole one (300,000 rows, unindexed order: 63–92 ms as
// subqueries, 298–332 ms joined after the sort, 27 ms paged first).
describe("PostgreSQL to-one relations", () => {
  const engine = new TestQueryEngine(
    new SqlOnlyDriver(postgresAdapter, "postgresql"),
    createModelRegistry(schema, createSchemaRegistry(schema))
  );

  test("a bounded page is read first, then joined to its to-one relations and ordered again", () => {
    const statement = engine.build(Post, "findMany", {
      orderBy: { title: "asc" },
      take: 20,
      include: { author: true },
    });
    expect(statement.toStatement("$n")).toBe(
      'SELECT "q0"."id", "q0"."title", "q0"."content", "q0"."authorId", "q3"."r" AS "author" FROM (SELECT "q0"."id", "q0"."title", "q0"."content", "q0"."authorId" FROM "public"."posts" AS "q0" ORDER BY "q0"."title" ASC, "q0"."id" ASC LIMIT $1) AS "q0" LEFT JOIN LATERAL (SELECT json_build_object($2::text, "q2"."id", $3::text, "q2"."name", $4::text, "q2"."email") AS "r" FROM (SELECT "q1"."id", "q1"."name", "q1"."email" FROM "public"."Author" AS "q1" WHERE "q0"."authorId" = "q1"."id" LIMIT $5) AS "q2") AS "q3" ON TRUE ORDER BY "q0"."title" ASC, "q0"."id" ASC'
    );
    expect(statement.values).toEqual([20, "id", "name", "email", 1]);
  });

  test("an unbounded read joins its to-one relations laterally", () => {
    const statement = engine.build(Post, "findMany", {
      include: { author: true },
    });
    expect(statement.toStatement("$n")).toBe(
      'SELECT "q0"."id", "q0"."title", "q0"."content", "q0"."authorId", "q3"."r" AS "author" FROM "public"."posts" AS "q0" LEFT JOIN LATERAL (SELECT json_build_object($1::text, "q2"."id", $2::text, "q2"."name", $3::text, "q2"."email") AS "r" FROM (SELECT "q1"."id", "q1"."name", "q1"."email" FROM "public"."Author" AS "q1" WHERE "q0"."authorId" = "q1"."id" LIMIT $4) AS "q2") AS "q3" ON TRUE ORDER BY "q0"."id" ASC'
    );
    expect(statement.values).toEqual(["id", "name", "email", 1]);
  });

  test("a bounded page ordered through its own joins keeps the subquery", () => {
    const statement = engine.build(Post, "findMany", {
      orderBy: { author: { name: "asc" } },
      take: 2,
      include: { author: true },
    });
    expect(statement.toStatement("$n")).toBe(
      'SELECT "q0"."id", "q0"."title", "q0"."content", "q0"."authorId", (SELECT json_build_object($1::text, "q3"."id", $2::text, "q3"."name", $3::text, "q3"."email") FROM (SELECT "q2"."id", "q2"."name", "q2"."email" FROM "public"."Author" AS "q2" WHERE "q0"."authorId" = "q2"."id" LIMIT $4) AS "q3") AS "author" FROM "public"."posts" AS "q0" LEFT JOIN "public"."Author" AS "q1" ON "q0"."authorId" = "q1"."id" ORDER BY "q1"."name" ASC NULLS LAST, "q0"."id" ASC LIMIT $5'
    );
    expect(statement.values).toEqual(["id", "name", "email", 1, 2]);
  });

  test("a bounded related page keeps its to-one relations as subqueries", () => {
    const statement = engine.build(Author, "findMany", {
      include: {
        posts: {
          orderBy: { title: "asc" },
          take: 2,
          include: { author: true },
        },
      },
    });
    expect(statement.toStatement("$n")).toBe(
      'SELECT "q0"."id", "q0"."name", "q0"."email", (SELECT COALESCE(json_agg(json_build_object($1::text, "q4"."id", $2::text, "q4"."title", $3::text, "q4"."content", $4::text, "q4"."authorId", $5::text, "q4"."author")), \'[]\'::json) FROM (SELECT "q1"."id", "q1"."title", "q1"."content", "q1"."authorId", (SELECT json_build_object($6::text, "q3"."id", $7::text, "q3"."name", $8::text, "q3"."email") FROM (SELECT "q2"."id", "q2"."name", "q2"."email" FROM "public"."Author" AS "q2" WHERE "q1"."authorId" = "q2"."id" LIMIT $9) AS "q3") AS "author" FROM "public"."posts" AS "q1" WHERE "q0"."id" = "q1"."authorId" ORDER BY "q1"."title" ASC, "q1"."id" ASC LIMIT $10) AS "q4") AS "posts" FROM "public"."Author" AS "q0" ORDER BY "q0"."id" ASC'
    );
    expect(statement.values).toEqual([
      "id",
      "title",
      "content",
      "authorId",
      "author",
      "id",
      "name",
      "email",
      1,
      2,
    ]);
  });

  test("an unbounded related page joins its to-one relations laterally inside itself", () => {
    const statement = engine.build(Author, "findMany", {
      include: { posts: { include: { author: true } } },
    });
    expect(statement.toStatement("$n")).toBe(
      'SELECT "q0"."id", "q0"."name", "q0"."email", (SELECT COALESCE(json_agg(json_build_object($1::text, "q5"."id", $2::text, "q5"."title", $3::text, "q5"."content", $4::text, "q5"."authorId", $5::text, "q5"."author")), \'[]\'::json) FROM (SELECT "q1"."id", "q1"."title", "q1"."content", "q1"."authorId", "q4"."r" AS "author" FROM "public"."posts" AS "q1" LEFT JOIN LATERAL (SELECT json_build_object($6::text, "q3"."id", $7::text, "q3"."name", $8::text, "q3"."email") AS "r" FROM (SELECT "q2"."id", "q2"."name", "q2"."email" FROM "public"."Author" AS "q2" WHERE "q1"."authorId" = "q2"."id" LIMIT $9) AS "q3") AS "q4" ON TRUE WHERE "q0"."id" = "q1"."authorId") AS "q5") AS "posts" FROM "public"."Author" AS "q0" ORDER BY "q0"."id" ASC'
    );
    expect(statement.values).toEqual([
      "id",
      "title",
      "content",
      "authorId",
      "author",
      "id",
      "name",
      "email",
      1,
    ]);
  });
});
