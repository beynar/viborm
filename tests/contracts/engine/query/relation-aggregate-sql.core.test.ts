/**
 * `_aggregate` and an order by an aggregate of a relation's rows, as
 * statements, with no database.
 *
 * Selected: ONE correlated subquery per relation, every aggregate it names
 * carried in it, whatever their number. Ordered: one correlated subquery per
 * sort key, apart from the projection's, as an order by `_count` is; a sum the
 * adapter orders exactly on two keys (SQLite's integers) takes two.
 *
 * SurrealDB and Snowflake refuse `_aggregate` and an order by an aggregate
 * with a typed error before any request.
 */

import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { createClient } from "@client/client";
import type { Dialect } from "@drivers";
import { createClient as createSnowflakeClient } from "@drivers/snowflake";
import { SurrealDriver } from "@drivers/surrealdb";
import { UnsupportedOperationError } from "@errors";
import { hydrateSchemaNames, s } from "@schema";
import { SqlOnlyDriver } from "@tests/fixtures/drivers/sql-only";
import {
  createModelRegistry,
  TestQueryEngine,
} from "@tests/fixtures/query-engine";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

const shop = s
  .model({
    id: s.int().id(),
    name: s.string(),
    orders: s.toMany(() => order),
  })
  .map("shop");
const order = s
  .model({
    id: s.int().id(),
    shopId: s.int(),
    shop: s
      .toOne(() => shop)
      .fields("shopId")
      .references("id"),
    quantity: s.int(),
    placedAt: s.dateTime(),
    published: s.boolean(),
  })
  .map("order");
const schema = { shop, order };
hydrateSchemaNames(schema);

const SELECTED = {
  select: {
    id: true,
    _aggregate: {
      orders: {
        where: { published: true },
        _count: true,
        _sum: { quantity: true },
        _max: { placedAt: true },
      },
    },
  },
  orderBy: { orders: { _max: { placedAt: { sort: "desc", nulls: "last" } } } },
} as const;
const SUMMED = {
  select: { id: true },
  orderBy: { orders: { _sum: { quantity: "desc" } } },
} as const;

const build = (
  adapter: PostgresAdapter | MySQLAdapter | SQLiteAdapter,
  dialect: Dialect,
  args: Record<string, unknown>
) => {
  const registry = createModelRegistry(schema, createSchemaRegistry(schema));
  const engine = new TestQueryEngine(
    new SqlOnlyDriver(adapter, dialect),
    registry
  );
  const query = engine.build(shop, "findMany", args);
  return { statement: query.toStatement("$n"), values: query.values };
};

describe("one correlated subquery per relation, one per sort key", () => {
  test("PostgreSQL", () => {
    expect(build(new PostgresAdapter(), "postgresql", SELECTED)).toEqual({
      statement: [
        `SELECT "q0"."id", json_build_array((SELECT json_build_array(COUNT(*), json_build_array(SUM("q2"."quantity")), json_build_array(MAX("q2"."placedAt")))`,
        ` FROM "public"."order" AS "q2" WHERE ("q0"."id" = "q2"."shopId" AND "q2"."published" = $1))) AS "_aggregate"`,
        ` FROM "public"."shop" AS "q0"`,
        ` ORDER BY (SELECT MAX("q1"."placedAt") FROM "public"."order" AS "q1" WHERE "q0"."id" = "q1"."shopId") DESC NULLS LAST, "q0"."id" ASC`,
      ].join(""),
      values: [true],
    });
    // An unspelled placement is PostgreSQL's own: NULL first when descending.
    expect(build(new PostgresAdapter(), "postgresql", SUMMED).statement).toBe(
      `SELECT "q0"."id" FROM "public"."shop" AS "q0" ORDER BY (SELECT SUM("q1"."quantity") FROM "public"."order" AS "q1" WHERE "q0"."id" = "q1"."shopId") DESC NULLS FIRST, "q0"."id" ASC`
    );
  });

  test("MySQL places NULL as PostgreSQL does, by a key of its own", () => {
    expect(build(new MySQLAdapter(), "mysql", SELECTED)).toEqual({
      statement: [
        "SELECT `q0`.`id`, JSON_ARRAY((SELECT JSON_ARRAY(COUNT(*), JSON_ARRAY(SUM(`q2`.`quantity`)), JSON_ARRAY(MAX(`q2`.`placedAt`)))",
        " FROM `order` AS `q2` WHERE (`q0`.`id` = `q2`.`shopId` AND `q2`.`published` = $1))) AS `_aggregate`",
        " FROM `shop` AS `q0`",
        " ORDER BY ((SELECT MAX(`q1`.`placedAt`) FROM `order` AS `q1` WHERE `q0`.`id` = `q1`.`shopId`) IS NULL) ASC,",
        " (SELECT MAX(`q1`.`placedAt`) FROM `order` AS `q1` WHERE `q0`.`id` = `q1`.`shopId`) DESC, `q0`.`id` ASC",
      ].join(""),
      values: [true],
    });
  });

  test("SQLite: an integer sum travels and sorts as its two exact parts", () => {
    expect(build(new SQLiteAdapter(), "sqlite", SELECTED)).toEqual({
      statement: [
        `SELECT "q0"."id" AS "id", json_array(json((SELECT json_array(COUNT(*),`,
        ` json_array(json_array(SUM("q2"."quantity" >> 32), SUM("q2"."quantity" - (("q2"."quantity" >> 32) << 32)))),`,
        ` json_array(MAX("q2"."placedAt")))`,
        ` FROM "order" AS "q2" WHERE ("q0"."id" = "q2"."shopId" AND "q2"."published" = $1)))) AS "_aggregate"`,
        ` FROM "shop" AS "q0"`,
        ` ORDER BY (SELECT MAX("q1"."placedAt") FROM "order" AS "q1" WHERE "q0"."id" = "q1"."shopId") DESC NULLS LAST, "q0"."id" ASC`,
      ].join(""),
      values: [true],
    });
    expect(build(new SQLiteAdapter(), "sqlite", SUMMED).statement).toBe(
      [
        `SELECT "q0"."id" AS "id" FROM "shop" AS "q0" ORDER BY`,
        ` (SELECT (SUM("q1"."quantity" >> 32) + (SUM("q1"."quantity" - (("q1"."quantity" >> 32) << 32)) >> 32)) FROM "order" AS "q1" WHERE "q0"."id" = "q1"."shopId") DESC NULLS FIRST,`,
        ` (SELECT (SUM("q1"."quantity" - (("q1"."quantity" >> 32) << 32)) & 4294967295) FROM "order" AS "q1" WHERE "q0"."id" = "q1"."shopId") DESC NULLS FIRST,`,
        ` "q0"."id" ASC`,
      ].join("")
    );
  });

  test("an aggregate refuses a cursor, as an order by _count does", () => {
    expect(() =>
      build(new PostgresAdapter(), "postgresql", {
        ...SUMMED,
        cursor: { id: 1 },
      })
    ).toThrow(UnsupportedOperationError);
  });
});

describe("SurrealDB and Snowflake", () => {
  test("SurrealDB refuses _aggregate and an order by an aggregate, its client never asked", async () => {
    const asked: PropertyKey[] = [];
    const surreal = new Proxy(
      {},
      {
        get: (_target, key) => {
          asked.push(key);
          throw new Error(`the SurrealDB client was asked for ${String(key)}`);
        },
      }
    );
    const client = createClient({
      schema,
      driver: new SurrealDriver({ client: surreal as never }),
    });
    await expect(
      client.shop.findMany({ select: SELECTED.select })
    ).rejects.toThrow(
      "The SurrealDB read backend does not support the aggregates of a relation's rows ('_aggregate') yet."
    );
    await expect(client.shop.findMany(SUMMED)).rejects.toThrow(
      "The SurrealDB read backend does not support ordering by '_sum' of the relation 'orders' yet."
    );
    expect(asked).toEqual([]);
  });

  test("Snowflake refuses _aggregate and an order by an aggregate before any request, and sends one by _count", async () => {
    const sent: string[] = [];
    const fetch = async (_input: string, init?: { body?: unknown }) => {
      sent.push(String(init?.body ?? ""));
      return Response.json({
        resultSetMetaData: { numRows: 0, format: "jsonv2", rowType: [] },
        data: [],
        code: "090001",
        statementHandle: "01b0-1",
        message: "Statement executed successfully.",
      });
    };
    const client = createSnowflakeClient({
      schema,
      account: "myorg-acct",
      token: "oauth-token",
      warehouse: "WH",
      database: "DB",
      namespace: "PUBLIC",
      fetch,
    });
    await expect(
      client.shop.findMany({ select: SELECTED.select })
    ).rejects.toThrow(
      "Snowflake reads a relation without the aggregates of its rows ('_aggregate')."
    );
    // At the root too: Snowflake documents a correlated subquery in WHERE
    // only, and this one, in ORDER BY, never ran on an account.
    await expect(client.shop.findMany(SUMMED)).rejects.toThrow(
      "Snowflake reads a relation without an order by an aggregate of its rows."
    );
    expect(sent).toEqual([]);
    await client.shop.findMany({
      select: { id: true },
      orderBy: { orders: { _count: "desc" } },
    });
    expect(sent.join("\n")).toContain("COUNT(");
  });
});
