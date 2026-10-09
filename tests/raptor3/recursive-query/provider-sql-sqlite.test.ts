import assert from "node:assert/strict";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createTestCommandEngine } from "@tests/raptor3/harness/command-engine";
import { s } from "@schema";
import type { QueryResult } from "@drivers/types";
import Database from "better-sqlite3";
import { describe, it } from "vitest";
import type { Schema } from "@client/types";
import {
  type ColumnType,
  columnDefinitions,
  GRAPH_WORLD,
  HIERARCHY_WORLD,
  PLACEMENT_MATRIX_TABLES,
  providerSchema,
  runCase,
  runPlacementMatrix,
  SELECT_SQL_PINS,
  sqlPins,
  type TableSpec,
} from "./provider-sql-fixture";

class ObservedSQLiteDriver extends SQLite3Driver {
  readonly statements: string[] = [];
  readonly rows: (Record<string, unknown>[] | undefined)[] = [];

  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[],
  ): Promise<QueryResult<T>> {
    this.statements.push(statement);
    this.rows.push(undefined);
    const index = this.rows.length - 1;
    const response = await super.execute<T>(client, statement, parameters);
    this.rows[index] = response.rows as Record<string, unknown>[];
    return response;
  }
}

const SQLITE_TYPES: Readonly<Record<ColumnType, string>> = {
  text: "TEXT",
  integer: "INTEGER",
  boolean: "INTEGER",
  json: "TEXT",
};

const quote = (identifier: string) => `"${identifier}"`;

/** One in-memory database per cell, seeded from the provider-neutral tables. */
function openWorld(schema: Schema, tables: readonly TableSpec[]) {
  const database = new Database(":memory:");
  for (const table of tables) {
    const quoted = table.columns.map((column) => quote(column.name));
    database.exec(
      `CREATE TABLE ${quote(table.name)}(${columnDefinitions(
        table,
        SQLITE_TYPES,
        quote,
      )})`,
    );
    const insert = database.prepare(
      `INSERT INTO "${table.name}"(${quoted.join(", ")}) VALUES (${quoted
        .map(() => "?")
        .join(", ")})`,
    );
    database.transaction(() => {
      for (const row of table.rows)
        insert.run(
          ...table.columns.map((column) => {
            const value = row[column.name];
            // better-sqlite3 binds no booleans: the physical SQLite spelling.
            return typeof value === "boolean" ? Number(value) : value;
          }),
        );
    })();
  }
  const driver = new ObservedSQLiteDriver({ client: database });
  return {
    driver,
    engine: createTestCommandEngine({ schema, driver }),
    async close() {
      await driver.disconnect();
      database.close();
    },
  };
}

describe("recursive relation provider SQL on SQLite", () => {
  it("pins the recursive select SQL byte for byte", async () => {
    const opened = openWorld(providerSchema, PLACEMENT_MATRIX_TABLES);
    try {
      assert.deepEqual(
        await sqlPins(opened.engine, opened.driver, SELECT_SQL_PINS),
        SELECT_SQL,
      );
    } finally {
      await opened.close();
    }
  });

  it("projects the recursive placement matrix through provider SQL", async () => {
    const opened = openWorld(providerSchema, PLACEMENT_MATRIX_TABLES);
    try {
      await runPlacementMatrix(opened.engine, opened.driver);
    } finally {
      await opened.close();
    }
  });

  it("keeps distinct physical DateTime keys for one logical instant", async () => {
    const table = "rq_datetime_nodes";
    const dateNode = (() => {
      const node = s
        .model({
          moment: s.dateTime().id(),
          label: s.string(),
          parentMoment: s.dateTime().nullable().map("parent_moment"),
          parent: s
            .toOne(() => node)
            .fields("parentMoment")
            .references("moment")
            .name("moments"),
          children: s.toMany(() => node).name("moments"),
        })
        .map(table);
      return node;
    })();
    const database = new Database(":memory:");
    database.exec(
      `CREATE TABLE ${table}(moment TEXT PRIMARY KEY, label TEXT NOT NULL, parent_moment TEXT)`,
    );
    const insert = database.prepare(
      `INSERT INTO ${table}(moment, label, parent_moment) VALUES (?, ?, ?)`,
    );
    const root = "2023-12-31T00:00:00.000Z";
    insert.run(root, "root", null);
    insert.run("2024-01-02T00:00:00.000Z", "utc", root);
    insert.run("2024-01-01T19:00:00.000-05:00", "offset", root);
    const driver = new ObservedSQLiteDriver({ client: database });
    const engine = createTestCommandEngine({ schema: { dateNode }, driver });
    try {
      const rows = await engine.execute("dateNode", "findMany", {
        where: { label: "root" },
        select: {
          label: true,
          children: {
            recurse: { depth: 1 },
            orderBy: { label: "asc" },
            select: { label: true, moment: true },
          },
        },
      });
      assert.deepEqual(
        rows,
        [
          {
            label: "root",
            children: [
              { label: "offset", moment: new Date("2024-01-02T00:00:00.000Z") },
              { label: "utc", moment: new Date("2024-01-02T00:00:00.000Z") },
            ],
          },
        ],
      );
      assert.equal(driver.statements.length, 1);
    } finally {
      await driver.disconnect();
      database.close();
    }
  });

  for (const world of [HIERARCHY_WORLD, GRAPH_WORLD])
    for (const group of world.groups)
      it(group.name, async () => {
        const opened = openWorld(world.schema, world.tables);
        try {
          for (const providerCase of group.cases)
            await runCase(opened.engine, opened.driver, providerCase);
        } finally {
          await opened.close();
        }
      });
});

/** The SQLite adapter's exact text for each pinned case. */
const SELECT_SQL: Readonly<Record<string, readonly string[] | string>> = {
  "foreign key up, bounded": [
    `SELECT "q0"."label" AS "label", (WITH RECURSIVE "__q1_recursive" AS (
        SELECT "q0"."tenant_key" AS "__q1_parent_0", "q0"."node_code" AS "__q1_parent_1", "q2"."tenant_key" AS "__q1_child_0", "q2"."node_code" AS "__q1_child_1", CAST(? AS INTEGER) AS "__q1_depth" FROM "rq_provider_nodes" AS "q2" WHERE ("q0"."parent_tenant" = "q2"."tenant_key" AND "q0"."parent_code" = "q2"."node_code")
        UNION
        SELECT "q3"."__q1_child_0" AS "__q1_parent_0", "q3"."__q1_child_1" AS "__q1_parent_1", "q5"."tenant_key" AS "__q1_child_0", "q5"."node_code" AS "__q1_child_1", ("q3"."__q1_depth" + ?) AS "__q1_depth" FROM "__q1_recursive" AS "q3" INNER JOIN "rq_provider_nodes" AS "q4" ON ("q4"."tenant_key" = "q3"."__q1_child_0" AND "q4"."node_code" = "q3"."__q1_child_1") INNER JOIN "rq_provider_nodes" AS "q5" ON ("q4"."parent_tenant" = "q5"."tenant_key" AND "q4"."parent_code" = "q5"."node_code") WHERE "q3"."__q1_depth" < ?
      ) SELECT json_object(?, json_array("q0"."tenant_key", "q0"."node_code"), ?, json((SELECT COALESCE(json_group_array(json(json_object(?, json_array("q7"."tenant_key", "q7"."node_code"), ?, json_object(?, "q7"."label")))), json_array()) FROM (SELECT "__q1_id_0", "__q1_id_1" FROM (SELECT "q3"."__q1_child_0" AS "__q1_id_0", "q3"."__q1_child_1" AS "__q1_id_1", ROW_NUMBER() OVER (PARTITION BY "q3"."__q1_child_0", "q3"."__q1_child_1" ORDER BY "q3"."__q1_child_0", "q3"."__q1_child_1") AS "_rn" FROM "__q1_recursive" AS "q3") AS "_distinct_subquery" WHERE "_rn" = 1) AS "q6" INNER JOIN "rq_provider_nodes" AS "q7" ON ("q7"."tenant_key" = "q6"."__q1_id_0" AND "q7"."node_code" = "q6"."__q1_id_1"))), ?, json((SELECT COALESCE(json_group_array(json(json("q10"."__q1_edge"))), json_array()) FROM (SELECT json_object(?, json_array("q8"."__q1_parent_0", "q8"."__q1_parent_1"), ?, json_array("q8"."__q1_child_0", "q8"."__q1_child_1"), ?, "q8"."__q1_depth") AS "__q1_edge" FROM "__q1_recursive" AS "q8" INNER JOIN "rq_provider_nodes" AS "q9" ON ("q9"."tenant_key" = "q8"."__q1_child_0" AND "q9"."node_code" = "q8"."__q1_child_1") ORDER BY "q8"."__q1_parent_0" ASC, "q8"."__q1_parent_1" ASC, "q9"."tenant_key" ASC, "q9"."node_code" ASC LIMIT -1) AS "q10")))) AS "parent" FROM "rq_provider_nodes" AS "q0" WHERE ("q0"."tenant_key" COLLATE BINARY = ? AND "q0"."node_code" COLLATE BINARY = ?) ORDER BY "q0"."tenant_key" ASC, "q0"."node_code" ASC`,
  ],
  "foreign key down, exhaustive, selector": [
    `SELECT "q0"."label" AS "label", (WITH RECURSIVE "__q1_recursive" AS (
        SELECT "q0"."tenant_key" AS "__q1_parent_0", "q0"."node_code" AS "__q1_parent_1", "q2"."tenant_key" AS "__q1_child_0", "q2"."node_code" AS "__q1_child_1" FROM "rq_provider_nodes" AS "q2" WHERE (("q0"."tenant_key" = "q2"."parent_tenant" AND "q0"."node_code" = "q2"."parent_code") AND "q2"."visible" = ?)
        UNION
        SELECT "q3"."__q1_child_0" AS "__q1_parent_0", "q3"."__q1_child_1" AS "__q1_parent_1", "q5"."tenant_key" AS "__q1_child_0", "q5"."node_code" AS "__q1_child_1" FROM "__q1_recursive" AS "q3" INNER JOIN "rq_provider_nodes" AS "q4" ON ("q4"."tenant_key" = "q3"."__q1_child_0" AND "q4"."node_code" = "q3"."__q1_child_1") INNER JOIN "rq_provider_nodes" AS "q5" ON ("q4"."tenant_key" = "q5"."parent_tenant" AND "q4"."node_code" = "q5"."parent_code") WHERE "q5"."visible" = ?
      ) SELECT json_object(?, json_array("q0"."tenant_key", "q0"."node_code"), ?, json((SELECT COALESCE(json_group_array(json(json_object(?, json_array("q7"."tenant_key", "q7"."node_code"), ?, json_object(?, "q7"."label")))), json_array()) FROM (SELECT "__q1_id_0", "__q1_id_1" FROM (SELECT "q3"."__q1_child_0" AS "__q1_id_0", "q3"."__q1_child_1" AS "__q1_id_1", ROW_NUMBER() OVER (PARTITION BY "q3"."__q1_child_0", "q3"."__q1_child_1" ORDER BY "q3"."__q1_child_0", "q3"."__q1_child_1") AS "_rn" FROM "__q1_recursive" AS "q3") AS "_distinct_subquery" WHERE "_rn" = 1) AS "q6" INNER JOIN "rq_provider_nodes" AS "q7" ON ("q7"."tenant_key" = "q6"."__q1_id_0" AND "q7"."node_code" = "q6"."__q1_id_1"))), ?, json((SELECT COALESCE(json_group_array(json(json("q10"."__q1_edge"))), json_array()) FROM (SELECT json_object(?, json_array("q8"."__q1_parent_0", "q8"."__q1_parent_1"), ?, json_array("q8"."__q1_child_0", "q8"."__q1_child_1")) AS "__q1_edge" FROM "__q1_recursive" AS "q8" INNER JOIN "rq_provider_nodes" AS "q9" ON ("q9"."tenant_key" = "q8"."__q1_child_0" AND "q9"."node_code" = "q8"."__q1_child_1") ORDER BY "q8"."__q1_parent_0" ASC, "q8"."__q1_parent_1" ASC, "q9"."tenant_key" ASC, "q9"."node_code" ASC LIMIT -1) AS "q10")))) AS "children" FROM "rq_provider_nodes" AS "q0" WHERE ("q0"."tenant_key" COLLATE BINARY = ? AND "q0"."node_code" COLLATE BINARY = ?) ORDER BY "q0"."tenant_key" ASC, "q0"."node_code" ASC`,
  ],
  "junction, bounded, selector": [
    `SELECT "q0"."label" AS "label", (WITH RECURSIVE "__q1_recursive" AS (
        SELECT "q0"."tenant_key" AS "__q1_parent_0", "q0"."node_code" AS "__q1_parent_1", "q2"."tenant_key" AS "__q1_child_0", "q2"."node_code" AS "__q1_child_1", CAST(? AS INTEGER) AS "__q1_depth" FROM "rq_provider_nodes" AS "q2" WHERE (("q2"."tenant_key", "q2"."node_code") IN (SELECT "q3"."to_1", "q3"."to_2" FROM "rq_provider_links" AS "q3" WHERE ("q3"."from_1" = "q0"."tenant_key" AND "q3"."from_2" = "q0"."node_code")) AND "q2"."visible" = ?)
        UNION
        SELECT "q4"."__q1_child_0" AS "__q1_parent_0", "q4"."__q1_child_1" AS "__q1_parent_1", "q6"."tenant_key" AS "__q1_child_0", "q6"."node_code" AS "__q1_child_1", ("q4"."__q1_depth" + ?) AS "__q1_depth" FROM "__q1_recursive" AS "q4" INNER JOIN "rq_provider_nodes" AS "q5" ON ("q5"."tenant_key" = "q4"."__q1_child_0" AND "q5"."node_code" = "q4"."__q1_child_1") INNER JOIN "rq_provider_nodes" AS "q6" ON ("q6"."tenant_key", "q6"."node_code") IN (SELECT "q7"."to_1", "q7"."to_2" FROM "rq_provider_links" AS "q7" WHERE ("q7"."from_1" = "q5"."tenant_key" AND "q7"."from_2" = "q5"."node_code")) WHERE ("q4"."__q1_depth" < ? AND "q6"."visible" = ?)
      ) SELECT json_object(?, json_array("q0"."tenant_key", "q0"."node_code"), ?, json((SELECT COALESCE(json_group_array(json(json_object(?, json_array("q9"."tenant_key", "q9"."node_code"), ?, json_object(?, "q9"."label")))), json_array()) FROM (SELECT "__q1_id_0", "__q1_id_1" FROM (SELECT "q4"."__q1_child_0" AS "__q1_id_0", "q4"."__q1_child_1" AS "__q1_id_1", ROW_NUMBER() OVER (PARTITION BY "q4"."__q1_child_0", "q4"."__q1_child_1" ORDER BY "q4"."__q1_child_0", "q4"."__q1_child_1") AS "_rn" FROM "__q1_recursive" AS "q4") AS "_distinct_subquery" WHERE "_rn" = 1) AS "q8" INNER JOIN "rq_provider_nodes" AS "q9" ON ("q9"."tenant_key" = "q8"."__q1_id_0" AND "q9"."node_code" = "q8"."__q1_id_1"))), ?, json((SELECT COALESCE(json_group_array(json(json("q12"."__q1_edge"))), json_array()) FROM (SELECT json_object(?, json_array("q10"."__q1_parent_0", "q10"."__q1_parent_1"), ?, json_array("q10"."__q1_child_0", "q10"."__q1_child_1"), ?, "q10"."__q1_depth") AS "__q1_edge" FROM "__q1_recursive" AS "q10" INNER JOIN "rq_provider_nodes" AS "q11" ON ("q11"."tenant_key" = "q10"."__q1_child_0" AND "q11"."node_code" = "q10"."__q1_child_1") ORDER BY "q10"."__q1_parent_0" ASC, "q10"."__q1_parent_1" ASC, "q11"."node_code" ASC, "q11"."tenant_key" ASC LIMIT -1) AS "q12")))) AS "neighbors" FROM "rq_provider_nodes" AS "q0" WHERE ("q0"."tenant_key" COLLATE BINARY = ? AND "q0"."node_code" COLLATE BINARY = ?) ORDER BY "q0"."tenant_key" ASC, "q0"."node_code" ASC`,
  ],
  "junction, exhaustive": [
    `SELECT "q0"."label" AS "label", (WITH RECURSIVE "__q1_recursive" AS (
        SELECT "q0"."tenant_key" AS "__q1_parent_0", "q0"."node_code" AS "__q1_parent_1", "q2"."tenant_key" AS "__q1_child_0", "q2"."node_code" AS "__q1_child_1" FROM "rq_provider_nodes" AS "q2" WHERE ("q2"."tenant_key", "q2"."node_code") IN (SELECT "q3"."to_1", "q3"."to_2" FROM "rq_provider_links" AS "q3" WHERE ("q3"."from_1" = "q0"."tenant_key" AND "q3"."from_2" = "q0"."node_code"))
        UNION
        SELECT "q4"."__q1_child_0" AS "__q1_parent_0", "q4"."__q1_child_1" AS "__q1_parent_1", "q6"."tenant_key" AS "__q1_child_0", "q6"."node_code" AS "__q1_child_1" FROM "__q1_recursive" AS "q4" INNER JOIN "rq_provider_nodes" AS "q5" ON ("q5"."tenant_key" = "q4"."__q1_child_0" AND "q5"."node_code" = "q4"."__q1_child_1") INNER JOIN "rq_provider_nodes" AS "q6" ON ("q6"."tenant_key", "q6"."node_code") IN (SELECT "q7"."to_1", "q7"."to_2" FROM "rq_provider_links" AS "q7" WHERE ("q7"."from_1" = "q5"."tenant_key" AND "q7"."from_2" = "q5"."node_code")) WHERE 1
      ) SELECT json_object(?, json_array("q0"."tenant_key", "q0"."node_code"), ?, json((SELECT COALESCE(json_group_array(json(json_object(?, json_array("q9"."tenant_key", "q9"."node_code"), ?, json_object(?, "q9"."label")))), json_array()) FROM (SELECT "__q1_id_0", "__q1_id_1" FROM (SELECT "q4"."__q1_child_0" AS "__q1_id_0", "q4"."__q1_child_1" AS "__q1_id_1", ROW_NUMBER() OVER (PARTITION BY "q4"."__q1_child_0", "q4"."__q1_child_1" ORDER BY "q4"."__q1_child_0", "q4"."__q1_child_1") AS "_rn" FROM "__q1_recursive" AS "q4") AS "_distinct_subquery" WHERE "_rn" = 1) AS "q8" INNER JOIN "rq_provider_nodes" AS "q9" ON ("q9"."tenant_key" = "q8"."__q1_id_0" AND "q9"."node_code" = "q8"."__q1_id_1"))), ?, json((SELECT COALESCE(json_group_array(json(json("q12"."__q1_edge"))), json_array()) FROM (SELECT json_object(?, json_array("q10"."__q1_parent_0", "q10"."__q1_parent_1"), ?, json_array("q10"."__q1_child_0", "q10"."__q1_child_1")) AS "__q1_edge" FROM "__q1_recursive" AS "q10" INNER JOIN "rq_provider_nodes" AS "q11" ON ("q11"."tenant_key" = "q10"."__q1_child_0" AND "q11"."node_code" = "q10"."__q1_child_1") ORDER BY "q10"."__q1_parent_0" ASC, "q10"."__q1_parent_1" ASC, "q11"."node_code" ASC, "q11"."tenant_key" ASC LIMIT -1) AS "q12")))) AS "neighbors" FROM "rq_provider_nodes" AS "q0" WHERE ("q0"."tenant_key" COLLATE BINARY = ? AND "q0"."node_code" COLLATE BINARY = ?) ORDER BY "q0"."tenant_key" ASC, "q0"."node_code" ASC`,
  ],
};
