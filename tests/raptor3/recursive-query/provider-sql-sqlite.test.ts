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
  FILTER_SQL_PINS,
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

  it("pins the recursive filter SQL byte for byte", async () => {
    const opened = openWorld(providerSchema, PLACEMENT_MATRIX_TABLES);
    try {
      assert.deepEqual(
        await sqlPins(opened.engine, opened.driver, FILTER_SQL_PINS),
        FILTER_SQL,
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
        SELECT "q4"."__q1_child_0" AS "__q1_parent_0", "q4"."__q1_child_1" AS "__q1_parent_1", "q6"."tenant_key" AS "__q1_child_0", "q6"."node_code" AS "__q1_child_1", ("q4"."__q1_depth" + ?) AS "__q1_depth" FROM "__q1_recursive" AS "q4" INNER JOIN "rq_provider_nodes" AS "q5" ON ("q5"."tenant_key" = "q4"."__q1_child_0" AND "q5"."node_code" = "q4"."__q1_child_1") INNER JOIN "rq_provider_links" AS "q7" ON ("q7"."from_1" = "q5"."tenant_key" AND "q7"."from_2" = "q5"."node_code") INNER JOIN "rq_provider_nodes" AS "q6" ON ("q7"."to_1" = "q6"."tenant_key" AND "q7"."to_2" = "q6"."node_code") WHERE ("q4"."__q1_depth" < ? AND "q6"."visible" = ?)
      ) SELECT json_object(?, json_array("q0"."tenant_key", "q0"."node_code"), ?, json((SELECT COALESCE(json_group_array(json(json_object(?, json_array("q9"."tenant_key", "q9"."node_code"), ?, json_object(?, "q9"."label")))), json_array()) FROM (SELECT "__q1_id_0", "__q1_id_1" FROM (SELECT "q4"."__q1_child_0" AS "__q1_id_0", "q4"."__q1_child_1" AS "__q1_id_1", ROW_NUMBER() OVER (PARTITION BY "q4"."__q1_child_0", "q4"."__q1_child_1" ORDER BY "q4"."__q1_child_0", "q4"."__q1_child_1") AS "_rn" FROM "__q1_recursive" AS "q4") AS "_distinct_subquery" WHERE "_rn" = 1) AS "q8" INNER JOIN "rq_provider_nodes" AS "q9" ON ("q9"."tenant_key" = "q8"."__q1_id_0" AND "q9"."node_code" = "q8"."__q1_id_1"))), ?, json((SELECT COALESCE(json_group_array(json(json("q12"."__q1_edge"))), json_array()) FROM (SELECT json_object(?, json_array("q10"."__q1_parent_0", "q10"."__q1_parent_1"), ?, json_array("q10"."__q1_child_0", "q10"."__q1_child_1"), ?, "q10"."__q1_depth") AS "__q1_edge" FROM "__q1_recursive" AS "q10" INNER JOIN "rq_provider_nodes" AS "q11" ON ("q11"."tenant_key" = "q10"."__q1_child_0" AND "q11"."node_code" = "q10"."__q1_child_1") ORDER BY "q10"."__q1_parent_0" ASC, "q10"."__q1_parent_1" ASC, "q11"."node_code" ASC, "q11"."tenant_key" ASC LIMIT -1) AS "q12")))) AS "neighbors" FROM "rq_provider_nodes" AS "q0" WHERE ("q0"."tenant_key" COLLATE BINARY = ? AND "q0"."node_code" COLLATE BINARY = ?) ORDER BY "q0"."tenant_key" ASC, "q0"."node_code" ASC`,
  ],
  "junction, exhaustive": [
    `SELECT "q0"."label" AS "label", (WITH RECURSIVE "__q1_recursive" AS (
        SELECT "q0"."tenant_key" AS "__q1_parent_0", "q0"."node_code" AS "__q1_parent_1", "q2"."tenant_key" AS "__q1_child_0", "q2"."node_code" AS "__q1_child_1" FROM "rq_provider_nodes" AS "q2" WHERE ("q2"."tenant_key", "q2"."node_code") IN (SELECT "q3"."to_1", "q3"."to_2" FROM "rq_provider_links" AS "q3" WHERE ("q3"."from_1" = "q0"."tenant_key" AND "q3"."from_2" = "q0"."node_code"))
        UNION
        SELECT "q4"."__q1_child_0" AS "__q1_parent_0", "q4"."__q1_child_1" AS "__q1_parent_1", "q6"."tenant_key" AS "__q1_child_0", "q6"."node_code" AS "__q1_child_1" FROM "__q1_recursive" AS "q4" INNER JOIN "rq_provider_nodes" AS "q5" ON ("q5"."tenant_key" = "q4"."__q1_child_0" AND "q5"."node_code" = "q4"."__q1_child_1") INNER JOIN "rq_provider_links" AS "q7" ON ("q7"."from_1" = "q5"."tenant_key" AND "q7"."from_2" = "q5"."node_code") INNER JOIN "rq_provider_nodes" AS "q6" ON ("q7"."to_1" = "q6"."tenant_key" AND "q7"."to_2" = "q6"."node_code") WHERE 1
      ) SELECT json_object(?, json_array("q0"."tenant_key", "q0"."node_code"), ?, json((SELECT COALESCE(json_group_array(json(json_object(?, json_array("q9"."tenant_key", "q9"."node_code"), ?, json_object(?, "q9"."label")))), json_array()) FROM (SELECT "__q1_id_0", "__q1_id_1" FROM (SELECT "q4"."__q1_child_0" AS "__q1_id_0", "q4"."__q1_child_1" AS "__q1_id_1", ROW_NUMBER() OVER (PARTITION BY "q4"."__q1_child_0", "q4"."__q1_child_1" ORDER BY "q4"."__q1_child_0", "q4"."__q1_child_1") AS "_rn" FROM "__q1_recursive" AS "q4") AS "_distinct_subquery" WHERE "_rn" = 1) AS "q8" INNER JOIN "rq_provider_nodes" AS "q9" ON ("q9"."tenant_key" = "q8"."__q1_id_0" AND "q9"."node_code" = "q8"."__q1_id_1"))), ?, json((SELECT COALESCE(json_group_array(json(json("q12"."__q1_edge"))), json_array()) FROM (SELECT json_object(?, json_array("q10"."__q1_parent_0", "q10"."__q1_parent_1"), ?, json_array("q10"."__q1_child_0", "q10"."__q1_child_1")) AS "__q1_edge" FROM "__q1_recursive" AS "q10" INNER JOIN "rq_provider_nodes" AS "q11" ON ("q11"."tenant_key" = "q10"."__q1_child_0" AND "q11"."node_code" = "q10"."__q1_child_1") ORDER BY "q10"."__q1_parent_0" ASC, "q10"."__q1_parent_1" ASC, "q11"."node_code" ASC, "q11"."tenant_key" ASC LIMIT -1) AS "q12")))) AS "neighbors" FROM "rq_provider_nodes" AS "q0" WHERE ("q0"."tenant_key" COLLATE BINARY = ? AND "q0"."node_code" COLLATE BINARY = ?) ORDER BY "q0"."tenant_key" ASC, "q0"."node_code" ASC`,
  ],
};

const FILTER_SQL: Readonly<Record<string, readonly string[] | string>> = {
  "foreign-key ancestors with self, default depth": [
    `SELECT "q0"."node_code" AS "code" FROM "rq_provider_nodes" AS "q0" WHERE EXISTS (WITH RECURSIVE "__q3_recursive" AS (
        SELECT "q0"."tenant_key" AS "__q3_child_0", "q0"."node_code" AS "__q3_child_1", CAST(? AS INTEGER) AS "__q3_depth" UNION SELECT "q4"."tenant_key" AS "__q3_child_0", "q4"."node_code" AS "__q3_child_1", CAST(? AS INTEGER) AS "__q3_depth" FROM "rq_provider_nodes" AS "q4" WHERE ("q0"."parent_tenant" = "q4"."tenant_key" AND "q0"."parent_code" = "q4"."node_code")
        UNION
        SELECT "q7"."tenant_key" AS "__q3_child_0", "q7"."node_code" AS "__q3_child_1", ("q5"."__q3_depth" + ?) AS "__q3_depth" FROM "__q3_recursive" AS "q5" INNER JOIN "rq_provider_nodes" AS "q6" ON ("q6"."tenant_key" = "q5"."__q3_child_0" AND "q6"."node_code" = "q5"."__q3_child_1") INNER JOIN "rq_provider_nodes" AS "q7" ON ("q6"."parent_tenant" = "q7"."tenant_key" AND "q6"."parent_code" = "q7"."node_code") WHERE "q5"."__q3_depth" < ?
      ) SELECT 1 FROM "__q3_recursive" AS "q5" INNER JOIN "rq_provider_nodes" AS "q1" ON ("q1"."tenant_key" = "q5"."__q3_child_0" AND "q1"."node_code" = "q5"."__q3_child_1") WHERE EXISTS (SELECT 1 FROM "rq_provider_notes" AS "q2" WHERE (("q1"."tenant_key" = "q2"."node_tenant" AND "q1"."node_code" = "q2"."node_code") AND "q2"."text" COLLATE BINARY = ?))) ORDER BY "q0"."node_code" ASC, "q0"."tenant_key" ASC`,
  ],
  "junction walk with self, bounded, nested in a relation filter": [
    `SELECT "q0"."id" AS "id" FROM "rq_provider_notes" AS "q0" WHERE EXISTS (SELECT 1 FROM "rq_provider_nodes" AS "q1" WHERE (("q0"."node_tenant" = "q1"."tenant_key" AND "q0"."node_code" = "q1"."node_code") AND EXISTS (WITH RECURSIVE "__q4_recursive" AS (
        SELECT "q1"."tenant_key" AS "__q4_child_0", "q1"."node_code" AS "__q4_child_1", CAST(? AS INTEGER) AS "__q4_depth" UNION SELECT "q5"."tenant_key" AS "__q4_child_0", "q5"."node_code" AS "__q4_child_1", CAST(? AS INTEGER) AS "__q4_depth" FROM "rq_provider_nodes" AS "q5" WHERE ("q5"."tenant_key", "q5"."node_code") IN (SELECT "q6"."to_1", "q6"."to_2" FROM "rq_provider_links" AS "q6" WHERE ("q6"."from_1" = "q1"."tenant_key" AND "q6"."from_2" = "q1"."node_code"))
        UNION
        SELECT "q9"."tenant_key" AS "__q4_child_0", "q9"."node_code" AS "__q4_child_1", ("q7"."__q4_depth" + ?) AS "__q4_depth" FROM "__q4_recursive" AS "q7" INNER JOIN "rq_provider_nodes" AS "q8" ON ("q8"."tenant_key" = "q7"."__q4_child_0" AND "q8"."node_code" = "q7"."__q4_child_1") INNER JOIN "rq_provider_links" AS "q10" ON ("q10"."from_1" = "q8"."tenant_key" AND "q10"."from_2" = "q8"."node_code") INNER JOIN "rq_provider_nodes" AS "q9" ON ("q10"."to_1" = "q9"."tenant_key" AND "q10"."to_2" = "q9"."node_code") WHERE "q7"."__q4_depth" < ?
      ) SELECT 1 FROM "__q4_recursive" AS "q7" INNER JOIN "rq_provider_nodes" AS "q2" ON ("q2"."tenant_key" = "q7"."__q4_child_0" AND "q2"."node_code" = "q7"."__q4_child_1") WHERE (EXISTS (SELECT 1 FROM "rq_provider_notes" AS "q3" WHERE (("q2"."tenant_key" = "q3"."node_tenant" AND "q2"."node_code" = "q3"."node_code") AND "q3"."position" = ?)) OR "q2"."label" COLLATE BINARY = ?)))) ORDER BY "q0"."id" ASC`,
  ],
  "foreign-key descendants, exhaustive, none": [
    `SELECT "q0"."node_code" AS "code" FROM "rq_provider_nodes" AS "q0" WHERE NOT EXISTS (WITH RECURSIVE "__q2_recursive" AS (
        SELECT "q3"."tenant_key" AS "__q2_child_0", "q3"."node_code" AS "__q2_child_1" FROM "rq_provider_nodes" AS "q3" WHERE ("q0"."tenant_key" = "q3"."parent_tenant" AND "q0"."node_code" = "q3"."parent_code")
        UNION
        SELECT "q6"."tenant_key" AS "__q2_child_0", "q6"."node_code" AS "__q2_child_1" FROM "__q2_recursive" AS "q4" INNER JOIN "rq_provider_nodes" AS "q5" ON ("q5"."tenant_key" = "q4"."__q2_child_0" AND "q5"."node_code" = "q4"."__q2_child_1") INNER JOIN "rq_provider_nodes" AS "q6" ON ("q5"."tenant_key" = "q6"."parent_tenant" AND "q5"."node_code" = "q6"."parent_code") WHERE 1
      ) SELECT 1 FROM "__q2_recursive" AS "q4" INNER JOIN "rq_provider_nodes" AS "q1" ON ("q1"."tenant_key" = "q4"."__q2_child_0" AND "q1"."node_code" = "q4"."__q2_child_1") WHERE "q1"."visible" = ?) ORDER BY "q0"."node_code" ASC, "q0"."tenant_key" ASC`,
  ],
  "junction, one hop, every over empty closures": [
    `SELECT "q0"."node_code" AS "code" FROM "rq_provider_nodes" AS "q0" WHERE NOT EXISTS (WITH RECURSIVE "__q2_recursive" AS (
        SELECT "q3"."tenant_key" AS "__q2_child_0", "q3"."node_code" AS "__q2_child_1", CAST(? AS INTEGER) AS "__q2_depth" FROM "rq_provider_nodes" AS "q3" WHERE ("q3"."tenant_key", "q3"."node_code") IN (SELECT "q4"."to_1", "q4"."to_2" FROM "rq_provider_links" AS "q4" WHERE ("q4"."from_1" = "q0"."tenant_key" AND "q4"."from_2" = "q0"."node_code"))
        UNION
        SELECT "q7"."tenant_key" AS "__q2_child_0", "q7"."node_code" AS "__q2_child_1", ("q5"."__q2_depth" + ?) AS "__q2_depth" FROM "__q2_recursive" AS "q5" INNER JOIN "rq_provider_nodes" AS "q6" ON ("q6"."tenant_key" = "q5"."__q2_child_0" AND "q6"."node_code" = "q5"."__q2_child_1") INNER JOIN "rq_provider_links" AS "q8" ON ("q8"."from_1" = "q6"."tenant_key" AND "q8"."from_2" = "q6"."node_code") INNER JOIN "rq_provider_nodes" AS "q7" ON ("q8"."to_1" = "q7"."tenant_key" AND "q8"."to_2" = "q7"."node_code") WHERE "q5"."__q2_depth" < ?
      ) SELECT 1 FROM "__q2_recursive" AS "q5" INNER JOIN "rq_provider_nodes" AS "q1" ON ("q1"."tenant_key" = "q5"."__q2_child_0" AND "q1"."node_code" = "q5"."__q2_child_1") WHERE NOT ("q1"."rank" >= ?)) ORDER BY "q0"."node_code" ASC, "q0"."tenant_key" ASC`,
  ],
  "a closure nested in a closure": [
    `SELECT "q0"."node_code" AS "code" FROM "rq_provider_nodes" AS "q0" WHERE EXISTS (WITH RECURSIVE "__q10_recursive" AS (
        SELECT "q11"."tenant_key" AS "__q10_child_0", "q11"."node_code" AS "__q10_child_1", CAST(? AS INTEGER) AS "__q10_depth" FROM "rq_provider_nodes" AS "q11" WHERE ("q0"."parent_tenant" = "q11"."tenant_key" AND "q0"."parent_code" = "q11"."node_code")
        UNION
        SELECT "q14"."tenant_key" AS "__q10_child_0", "q14"."node_code" AS "__q10_child_1", ("q12"."__q10_depth" + ?) AS "__q10_depth" FROM "__q10_recursive" AS "q12" INNER JOIN "rq_provider_nodes" AS "q13" ON ("q13"."tenant_key" = "q12"."__q10_child_0" AND "q13"."node_code" = "q12"."__q10_child_1") INNER JOIN "rq_provider_nodes" AS "q14" ON ("q13"."parent_tenant" = "q14"."tenant_key" AND "q13"."parent_code" = "q14"."node_code") WHERE "q12"."__q10_depth" < ?
      ) SELECT 1 FROM "__q10_recursive" AS "q12" INNER JOIN "rq_provider_nodes" AS "q1" ON ("q1"."tenant_key" = "q12"."__q10_child_0" AND "q1"."node_code" = "q12"."__q10_child_1") WHERE EXISTS (WITH RECURSIVE "__q3_recursive" AS (
        SELECT "q1"."tenant_key" AS "__q3_child_0", "q1"."node_code" AS "__q3_child_1" UNION SELECT "q4"."tenant_key" AS "__q3_child_0", "q4"."node_code" AS "__q3_child_1" FROM "rq_provider_nodes" AS "q4" WHERE ("q4"."tenant_key", "q4"."node_code") IN (SELECT "q5"."to_1", "q5"."to_2" FROM "rq_provider_links" AS "q5" WHERE ("q5"."from_1" = "q1"."tenant_key" AND "q5"."from_2" = "q1"."node_code"))
        UNION
        SELECT "q8"."tenant_key" AS "__q3_child_0", "q8"."node_code" AS "__q3_child_1" FROM "__q3_recursive" AS "q6" INNER JOIN "rq_provider_nodes" AS "q7" ON ("q7"."tenant_key" = "q6"."__q3_child_0" AND "q7"."node_code" = "q6"."__q3_child_1") INNER JOIN "rq_provider_links" AS "q9" ON ("q9"."from_1" = "q7"."tenant_key" AND "q9"."from_2" = "q7"."node_code") INNER JOIN "rq_provider_nodes" AS "q8" ON ("q9"."to_1" = "q8"."tenant_key" AND "q9"."to_2" = "q8"."node_code") WHERE 1
      ) SELECT 1 FROM "__q3_recursive" AS "q6" INNER JOIN "rq_provider_nodes" AS "q2" ON ("q2"."tenant_key" = "q6"."__q3_child_0" AND "q2"."node_code" = "q6"."__q3_child_1") WHERE "q2"."node_code" COLLATE BINARY = ?)) ORDER BY "q0"."node_code" ASC, "q0"."tenant_key" ASC`,
  ],
  "updateMany walking the table it updates": [
    `UPDATE "rq_provider_nodes" SET "rank" = "rank" + ? WHERE EXISTS (WITH RECURSIVE "__q1_recursive" AS (
        SELECT "q2"."tenant_key" AS "__q1_child_0", "q2"."node_code" AS "__q1_child_1", CAST(? AS INTEGER) AS "__q1_depth" FROM "rq_provider_nodes" AS "q2" WHERE ("rq_provider_nodes"."parent_tenant" = "q2"."tenant_key" AND "rq_provider_nodes"."parent_code" = "q2"."node_code")
        UNION
        SELECT "q5"."tenant_key" AS "__q1_child_0", "q5"."node_code" AS "__q1_child_1", ("q3"."__q1_depth" + ?) AS "__q1_depth" FROM "__q1_recursive" AS "q3" INNER JOIN "rq_provider_nodes" AS "q4" ON ("q4"."tenant_key" = "q3"."__q1_child_0" AND "q4"."node_code" = "q3"."__q1_child_1") INNER JOIN "rq_provider_nodes" AS "q5" ON ("q4"."parent_tenant" = "q5"."tenant_key" AND "q4"."parent_code" = "q5"."node_code") WHERE "q3"."__q1_depth" < ?
      ) SELECT 1 FROM "__q1_recursive" AS "q3" INNER JOIN "rq_provider_nodes" AS "q0" ON ("q0"."tenant_key" = "q3"."__q1_child_0" AND "q0"."node_code" = "q3"."__q1_child_1") WHERE "q0"."node_code" COLLATE BINARY = ?)`,
  ],
  "updateMany walking another table": [
    `UPDATE "rq_provider_forests" SET "name" = ? WHERE EXISTS (SELECT 1 FROM "rq_provider_nodes" AS "q0" WHERE (("rq_provider_forests"."entry_tenant" = "q0"."tenant_key" AND "rq_provider_forests"."entry_code" = "q0"."node_code") AND EXISTS (WITH RECURSIVE "__q2_recursive" AS (
        SELECT "q3"."tenant_key" AS "__q2_child_0", "q3"."node_code" AS "__q2_child_1", CAST(? AS INTEGER) AS "__q2_depth" FROM "rq_provider_nodes" AS "q3" WHERE ("q0"."tenant_key" = "q3"."parent_tenant" AND "q0"."node_code" = "q3"."parent_code")
        UNION
        SELECT "q6"."tenant_key" AS "__q2_child_0", "q6"."node_code" AS "__q2_child_1", ("q4"."__q2_depth" + ?) AS "__q2_depth" FROM "__q2_recursive" AS "q4" INNER JOIN "rq_provider_nodes" AS "q5" ON ("q5"."tenant_key" = "q4"."__q2_child_0" AND "q5"."node_code" = "q4"."__q2_child_1") INNER JOIN "rq_provider_nodes" AS "q6" ON ("q5"."tenant_key" = "q6"."parent_tenant" AND "q5"."node_code" = "q6"."parent_code") WHERE "q4"."__q2_depth" < ?
      ) SELECT 1 FROM "__q2_recursive" AS "q4" INNER JOIN "rq_provider_nodes" AS "q1" ON ("q1"."tenant_key" = "q4"."__q2_child_0" AND "q1"."node_code" = "q4"."__q2_child_1") WHERE "q1"."node_code" COLLATE BINARY = ?)))`,
  ],
};
