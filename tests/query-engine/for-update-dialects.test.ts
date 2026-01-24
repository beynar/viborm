/**
 * FOR UPDATE SQL Generation Tests
 *
 * Verifies that forUpdate clause is correctly generated across all database dialects:
 * - PostgreSQL: Generates FOR UPDATE
 * - MySQL: Generates FOR UPDATE
 * - SQLite: No-op (uses database-level locking)
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { sql } from "@sql";
import { describe, expect, test } from "vitest";

describe("FOR UPDATE SQL Generation", () => {
  describe("PostgreSQL", () => {
    const adapter: DatabaseAdapter = new PostgresAdapter();

    test("generates FOR UPDATE clause when forUpdate is true", () => {
      const result = adapter.assemble.select({
        columns: sql`"id", "name"`,
        from: sql`"users" AS "t0"`,
        where: sql`"t0"."id" = $1`,
        limit: sql`1`,
        forUpdate: true,
      });

      const statement = result.toStatement("$n");
      expect(statement).toContain("FOR UPDATE");
    });

    test("does not generate FOR UPDATE clause when forUpdate is false", () => {
      const result = adapter.assemble.select({
        columns: sql`"id", "name"`,
        from: sql`"users" AS "t0"`,
        where: sql`"t0"."id" = $1`,
        limit: sql`1`,
        forUpdate: false,
      });

      const statement = result.toStatement("$n");
      expect(statement).not.toContain("FOR UPDATE");
    });

    test("does not generate FOR UPDATE clause when forUpdate is undefined", () => {
      const result = adapter.assemble.select({
        columns: sql`"id", "name"`,
        from: sql`"users" AS "t0"`,
        where: sql`"t0"."id" = $1`,
        limit: sql`1`,
      });

      const statement = result.toStatement("$n");
      expect(statement).not.toContain("FOR UPDATE");
    });
  });

  describe("MySQL", () => {
    const adapter: DatabaseAdapter = new MySQLAdapter();

    test("generates FOR UPDATE clause when forUpdate is true", () => {
      const result = adapter.assemble.select({
        columns: sql`\`id\`, \`name\``,
        from: sql`\`users\` AS \`t0\``,
        where: sql`\`t0\`.\`id\` = ?`,
        limit: sql`1`,
        forUpdate: true,
      });

      const statement = result.toStatement("?");
      expect(statement).toContain("FOR UPDATE");
    });

    test("does not generate FOR UPDATE clause when forUpdate is false", () => {
      const result = adapter.assemble.select({
        columns: sql`\`id\`, \`name\``,
        from: sql`\`users\` AS \`t0\``,
        where: sql`\`t0\`.\`id\` = ?`,
        limit: sql`1`,
        forUpdate: false,
      });

      const statement = result.toStatement("?");
      expect(statement).not.toContain("FOR UPDATE");
    });

    test("does not generate FOR UPDATE clause when forUpdate is undefined", () => {
      const result = adapter.assemble.select({
        columns: sql`\`id\`, \`name\``,
        from: sql`\`users\` AS \`t0\``,
        where: sql`\`t0\`.\`id\` = ?`,
        limit: sql`1`,
      });

      const statement = result.toStatement("?");
      expect(statement).not.toContain("FOR UPDATE");
    });
  });

  describe("SQLite", () => {
    const adapter: DatabaseAdapter = new SQLiteAdapter();

    test("does NOT generate FOR UPDATE clause (SQLite uses database-level locking)", () => {
      const result = adapter.assemble.select({
        columns: sql`"id", "name"`,
        from: sql`"users" AS "t0"`,
        where: sql`"t0"."id" = ?`,
        limit: sql`1`,
        forUpdate: true,
      });

      const statement = result.toStatement("?");
      // SQLite should NOT include FOR UPDATE - it uses database-level locking
      expect(statement).not.toContain("FOR UPDATE");
    });

    test("does not generate FOR UPDATE clause when forUpdate is false", () => {
      const result = adapter.assemble.select({
        columns: sql`"id", "name"`,
        from: sql`"users" AS "t0"`,
        where: sql`"t0"."id" = ?`,
        limit: sql`1`,
        forUpdate: false,
      });

      const statement = result.toStatement("?");
      expect(statement).not.toContain("FOR UPDATE");
    });
  });

  describe("Adapter capabilities", () => {
    test("PostgreSQL supports upsert WHERE clauses natively", () => {
      const adapter = new PostgresAdapter();
      expect(adapter.capabilities.supportsUpsertWhere).toBe(true);
    });

    test("MySQL does NOT support upsert WHERE clauses natively", () => {
      const adapter = new MySQLAdapter();
      expect(adapter.capabilities.supportsUpsertWhere).toBe(false);
    });

    test("SQLite supports upsert WHERE clauses natively", () => {
      const adapter = new SQLiteAdapter();
      expect(adapter.capabilities.supportsUpsertWhere).toBe(true);
    });
  });
});
