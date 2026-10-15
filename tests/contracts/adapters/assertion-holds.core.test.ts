/**
 * `assertions.holds`: the guard a write carries for the row it produces (rbac
 * plan K4, R4): 1 where the condition holds, the statement's own failure
 * otherwise, marked as an assertion (the driver maps its failure by the
 * marker). PostgreSQL's zero is a sublink, so a condition that folds false
 * while planning fails only where it is reached. The behaviour is
 * tests/contracts/engine/query/produced-row-behavior.ts on every database.
 */

import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { ASSERTION_MARKER } from "@drivers/error-mapping";
import { sql } from "@sql";
import { describe, expect, test } from "vitest";

const condition = sql.raw('"v"."id" = 1');
const from = sql.raw('(SELECT 1 AS "id") AS "v"');

describe("assertions.holds", () => {
  test.each([
    [
      "SQLite",
      new SQLiteAdapter(),
      `SELECT CASE WHEN "v"."id" = 1 THEN 1 ELSE json_extract('x', '$') END AS "${ASSERTION_MARKER}"`,
    ],
    [
      "PostgreSQL",
      new PostgresAdapter(),
      `SELECT 1 / CASE WHEN "v"."id" = 1 THEN 1 ELSE (SELECT 0) END AS "${ASSERTION_MARKER}"`,
    ],
    [
      "MySQL",
      new MySQLAdapter(),
      `SELECT CASE WHEN "v"."id" = 1 THEN 1 ELSE JSON_EXTRACT('x', '$') END AS \`${ASSERTION_MARKER}\``,
    ],
  ])("%s: alone, and over the row a FROM reads", (_name, adapter, alone) => {
    expect(adapter.assertions.holds(condition).toStatement()).toBe(alone);
    expect(adapter.assertions.holds(condition, from).toStatement()).toBe(
      `${alone} FROM (SELECT 1 AS "id") AS "v"`
    );
  });
});
