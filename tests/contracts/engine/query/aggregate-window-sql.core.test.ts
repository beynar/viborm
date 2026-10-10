/**
 * An aggregate is order-blind, so only a PAGED one reads a window.
 *
 * `count`, `aggregate` and `exist` once always wrapped their filter in a
 * key-ordered derived table — `SELECT COUNT(*) FROM (SELECT … ORDER BY id) q1`
 * — which forced a primary-key scan or a sort on every provider and denied
 * SQLite its btree count and covering indexes. The order only decides WHICH
 * rows a page (`take`, `skip`, `cursor`) keeps; without a page the statement
 * is the aggregate over the filtered table itself, on every dialect.
 */
import type { DatabaseAdapter } from "@adapters/database-adapter";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import type { Dialect } from "@drivers";
import type { Operation } from "@query-engine/types";
import { hydrateSchemaNames, s } from "@schema";
import { SqlOnlyDriver } from "@tests/fixtures/drivers/sql-only";
import {
  createModelRegistry,
  TestQueryEngine,
} from "@tests/fixtures/query-engine";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

const author = s.model({
  id: s.int().id().increment(),
  email: s.string().unique(),
  posts: s.toMany(() => post),
});
const post = s.model({
  id: s.int().id().increment(),
  title: s.string(),
  views: s.int(),
  authorId: s.int(),
  author: s
    .toOne(() => author)
    .fields("authorId")
    .references("id"),
  createdAt: s.dateTime().now(),
  updatedAt: s.dateTime().updatedAt(),
});
const schema = { author, post };
hydrateSchemaNames(schema);
const registry = createModelRegistry(schema, createSchemaRegistry(schema));

const DIALECTS: ReadonlyArray<readonly [Dialect, DatabaseAdapter]> = [
  ["sqlite", new SQLiteAdapter()],
  ["postgresql", new PostgresAdapter()],
  ["mysql", new MySQLAdapter()],
];

const UNPAGED: ReadonlyArray<readonly [Operation, Record<string, unknown>]> = [
  ["count", {}],
  ["count", { where: { authorId: 7 } }],
  ["count", { select: { _all: true, title: true } }],
  // A caller's order without a page decides nothing an aggregate reads.
  ["count", { where: { views: { gt: 10 } }, orderBy: { views: "desc" } }],
  ["aggregate", { _sum: { views: true }, where: { views: { gt: 10 } } }],
  ["aggregate", { _count: true, _min: { createdAt: true } }],
  ["exist", { where: { authorId: 7 } }],
  ["exist", {}],
];

const PAGED: ReadonlyArray<readonly [Operation, Record<string, unknown>]> = [
  ["count", { take: 10 }],
  ["count", { skip: 5 }],
  ["count", { cursor: { id: 3 } }],
  ["aggregate", { _sum: { views: true }, orderBy: { views: "asc" }, take: 3 }],
];

const ORDERED = /\bORDER BY\b/;
const DERIVED = /\bFROM \(/;

describe.each(DIALECTS)("%s aggregate statements", (dialect, adapter) => {
  const engine = new TestQueryEngine(
    new SqlOnlyDriver(adapter, dialect),
    registry
  );
  const text = (operation: Operation, args: Record<string, unknown>) =>
    engine.build(post, operation, args).toStatement("?");

  test.each(UNPAGED)("unpaged %s %j reads the filtered table", (op, args) => {
    const statement = text(op, args);
    expect(statement).not.toMatch(ORDERED);
    expect(statement).not.toMatch(DERIVED);
    expect(statement).not.toContain("LIMIT");
  });

  test.each(PAGED)("paged %s %j keeps its ordered window", (op, args) => {
    const statement = text(op, args);
    expect(statement).toMatch(ORDERED);
    expect(statement).toMatch(DERIVED);
  });
});
