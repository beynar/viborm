import assert from "node:assert/strict";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCommandEngine } from "@query-engine/raptor3/commands";
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
    engine: createCommandEngine({ schema, driver }),
    async close() {
      await driver.disconnect();
      database.close();
    },
  };
}

describe("recursive relation provider SQL on SQLite", () => {
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
    const engine = createCommandEngine({ schema: { dateNode }, driver });
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
