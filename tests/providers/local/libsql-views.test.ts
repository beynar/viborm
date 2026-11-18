/**
 * Views on LibSQL, which refuses live migration commands: the statements the
 * migration driver renders run by hand, introspection reads the view back by
 * its marker with the fingerprint of the declaration, and a change to a
 * column it reads runs with the view dropped before and created after.
 */

import { getMigrationDriver } from "@migrations/drivers";
import { fingerprintSnapshot } from "@migrations/push-fingerprint";
import type { DiffOperation, SchemaSnapshot } from "@migrations/types";
import { prepareSchemaProgram } from "@migrations/utils";
import { createInMemoryLibSQLDriver } from "@tests/fixtures/drivers/libsql";
import { expect, test } from "vitest";

const HASH = "d".repeat(40);
const TABLE = {
  name: "view_posts",
  columns: [
    { name: "id", type: "TEXT", nullable: false },
    { name: "score", type: "INTEGER", nullable: false },
  ],
  primaryKey: { columns: ["id"] },
  indexes: [],
  foreignKeys: [],
  uniqueConstraints: [],
};
const DECLARED: SchemaSnapshot = {
  tables: [TABLE],
  views: [
    {
      name: "view_feed",
      hash: HASH,
      sql: 'SELECT "id" FROM "view_posts" WHERE "score" > 0',
      dependsOn: ["view_posts"],
    },
  ],
};

test("LibSQL runs the rendered view, reads it back and alters around it", async () => {
  const driver = createInMemoryLibSQLDriver();
  try {
    const command = getMigrationDriver(driver);
    const introspect = () =>
      command.introspect((statement, parameters) =>
        driver._executeRaw(statement, parameters)
      );
    const run = async (
      operations: DiffOperation[],
      current: SchemaSnapshot
    ) => {
      for (const [index, operation] of operations.entries())
        for (const statement of command.compileStatements(operation, {
          destination: "live",
          currentSchema: current,
          precedingOperations: operations.slice(0, index),
        }))
          await driver._executeRaw(statement);
    };
    await run(
      [
        { type: "createTable", table: TABLE },
        { type: "createView", view: DECLARED.views![0]! },
      ],
      { tables: [] }
    );
    await driver._executeRaw(
      `INSERT INTO "view_posts" ("id", "score") VALUES ('a', 0), ('b', 1)`
    );
    const live = await introspect();
    expect(live.views).toEqual([
      { name: "view_feed", hash: HASH, dependsOn: [] },
    ]);
    expect(fingerprintSnapshot(live, command)).toBe(
      fingerprintSnapshot(DECLARED, command)
    );

    // A change to a column it reads: the program puts the view around it.
    const nullable: SchemaSnapshot = {
      ...DECLARED,
      tables: [
        {
          ...TABLE,
          columns: TABLE.columns.map((column) =>
            column.name === "score" ? { ...column, nullable: true } : column
          ),
        },
      ],
    };
    const program = prepareSchemaProgram(
      [
        {
          type: "alterColumn",
          tableName: "view_posts",
          columnName: "score",
          from: TABLE.columns[1]!,
          to: { ...TABLE.columns[1]!, nullable: true },
        },
      ],
      DECLARED,
      nullable,
      command
    );
    expect(program.map(({ type }) => type)).toEqual([
      "dropView",
      "alterColumn",
      "createView",
    ]);
    await run(program, live);
    expect((await introspect()).views).toEqual(live.views);
    const rows = await driver._executeRaw<{ id: string }>(
      'SELECT "id" FROM "view_feed"'
    );
    expect(rows.rows.map(({ id }) => id)).toEqual(["b"]);
  } finally {
    await driver.disconnect();
  }
});
