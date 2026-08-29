/**
 * SQLite fixed-decimal reconstruction integrity.
 *
 * These cases exercise boundaries that only exist while a table is rebuilt:
 * correlated JSON list reads, hostile physical storage behind a descriptor
 * carrier, the carrier's agreement with PRAGMA facts, and column renames whose
 * effects SQLite must propagate to foreign keys outside the rebuilt table.
 */

import { createClient } from "@client/client";
import { push } from "@migrations";
import { sqlite3MigrationDriver } from "@migrations/drivers/sqlite";
import { sqliteDecimalCheck } from "@migrations/drivers/sqlite/decimal";
import { invertOperations } from "@migrations/generate/down";
import {
  executeDDLStatements,
  generateDDLStatements,
} from "@migrations/push/executor";
import type {
  DiffOperation,
  ForeignKeyDef,
  SchemaSnapshot,
  TableDef,
} from "@migrations/types";
import { s } from "@schema";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { describe, expect, it } from "vitest";
import { ddlContext } from "./_estate";

const COLLIDING_JSON_EACH_COLUMNS = [
  "key",
  "value",
  "type",
  "atom",
  "id",
  "parent",
  "fullkey",
  "path",
  "json",
  "root",
];

const DECIMAL = { precision: 10, scale: 2 };
const RESERVED_CARRIER_REFUSAL = /reserved|VibORM wrote/i;

function collisionSchema(scale: number) {
  const list = () => s.decimal({ precision: 10, scale }).array();
  return {
    ledger: s
      .model({
        recordId: s.string().id().map("record_id"),
        key: list(),
        value: list(),
        type: list(),
        atom: list(),
        id: list(),
        parent: list(),
        fullkey: list(),
        path: list(),
        json: list(),
        root: list(),
      })
      .map("decimal_list_alias_collision"),
  };
}

function listSchema(scale: number) {
  return {
    ledger: s
      .model({
        id: s.string().id(),
        samples: s.decimal({ precision: 10, scale }).array(),
      })
      .map("decimal_list_blob"),
  };
}

async function executeDdl(
  driver: ReturnType<typeof createInMemorySQLite3Driver>,
  ddl: string
): Promise<void> {
  for (const statement of ddl.split(";\n")) {
    if (statement.trim()) await driver._executeRaw(statement);
  }
}

async function createSnapshotTables(
  driver: ReturnType<typeof createInMemorySQLite3Driver>,
  snapshot: SchemaSnapshot
): Promise<void> {
  for (const table of snapshot.tables) {
    await executeDdl(
      driver,
      sqlite3MigrationDriver.generateDDL(
        { type: "createTable", table },
        ddlContext("live")
      )
    );
  }
}

function scalarDecimal(name: string, nullable = false) {
  return {
    name,
    type: "INTEGER",
    nullable,
    decimal: DECIMAL,
  };
}

function textColumn(name: string, nullable = false) {
  return { name, type: "TEXT", nullable };
}

function table(
  name: string,
  columns: TableDef["columns"],
  options: {
    primaryKey?: TableDef["primaryKey"];
    foreignKeys?: ForeignKeyDef[];
  } = {}
): TableDef {
  return {
    name,
    columns,
    primaryKey: options.primaryKey,
    indexes: [],
    foreignKeys: options.foreignKeys ?? [],
    uniqueConstraints: [],
  };
}

async function foreignKeys(
  driver: ReturnType<typeof createInMemorySQLite3Driver>,
  tableName: string
) {
  const rows = (
    await driver._executeRaw<{
      seq: number;
      table: string;
      from: string;
      to: string;
    }>(`PRAGMA foreign_key_list("${tableName}")`)
  ).rows;
  return rows.map((row) => ({
    seq: row.seq,
    table: row.table,
    from: row.from,
    to: row.to,
  }));
}

describe("SQLite decimal reconstruction integrity", () => {
  it("keeps every json_each-named list column nonempty and duplicate-preserving", async () => {
    const driver = createInMemorySQLite3Driver();
    const before = createClient({ schema: collisionSchema(2), driver });
    await push(before, { force: true });

    const columns = COLLIDING_JSON_EACH_COLUMNS.map((name) => `"${name}"`);
    const values = COLLIDING_JSON_EACH_COLUMNS.map(
      () => `'["120","-3","120"]'`
    );
    await driver._executeRaw(
      `INSERT INTO "decimal_list_alias_collision" ("record_id",${columns.join(",")}) VALUES ('row',${values.join(",")})`
    );

    const after = createClient({ schema: collisionSchema(4), driver });
    await push(after, { force: true });

    const stored = await driver._executeRaw<Record<string, string>>(
      `SELECT ${columns.join(",")} FROM "decimal_list_alias_collision"`
    );
    for (const name of COLLIDING_JSON_EACH_COLUMNS) {
      expect(stored.rows[0]?.[name]).toBe('["12000","-300","12000"]');
    }
    await after.$disconnect();
  });

  it("refuses a BLOB-backed JSON list atomically instead of adopting its bytes", async () => {
    const driver = createInMemorySQLite3Driver();
    const before = createClient({ schema: listSchema(2), driver });
    await push(before, { force: true });
    await driver._executeRaw("PRAGMA ignore_check_constraints=ON");
    await driver._executeRaw(
      `INSERT INTO "decimal_list_blob" ("id","samples") VALUES ('row', CAST('["120","-3"]' AS BLOB))`
    );
    await driver._executeRaw("PRAGMA ignore_check_constraints=OFF");

    const after = createClient({ schema: listSchema(4), driver });
    await expect(push(after, { force: true })).rejects.toThrow();

    const stored = await driver._executeRaw<{
      storage: string;
      value: string;
    }>(
      `SELECT typeof("samples") AS storage, CAST("samples" AS TEXT) AS value FROM "decimal_list_blob"`
    );
    expect(stored.rows).toEqual([{ storage: "blob", value: '["120","-3"]' }]);
    await after.$disconnect();
  });

  it("refuses carriers whose kind or nullability contradicts PRAGMA facts", async () => {
    const listDriver = createInMemorySQLite3Driver();
    const listCheck = sqliteDecimalCheck(
      { name: "samples", nullable: false },
      DECIMAL,
      "list",
      (name) => `"${name.replace(/"/g, '""')}"`
    );
    await listDriver._executeRaw(
      `CREATE TABLE "wrong_kind" ("samples" INTEGER NOT NULL ${listCheck})`
    );
    await expect(
      sqlite3MigrationDriver.introspect((sql, params) =>
        listDriver._executeRaw(sql, params)
      )
    ).rejects.toThrow(RESERVED_CARRIER_REFUSAL);

    const nullableDriver = createInMemorySQLite3Driver();
    const nonNullCheck = sqliteDecimalCheck(
      { name: "amount", nullable: false },
      DECIMAL,
      "scalar",
      (name) => `"${name.replace(/"/g, '""')}"`
    );
    await nullableDriver._executeRaw(
      `CREATE TABLE "wrong_nullability" ("amount" INTEGER ${nonNullCheck})`
    );
    await expect(
      sqlite3MigrationDriver.introspect((sql, params) =>
        nullableDriver._executeRaw(sql, params)
      )
    ).rejects.toThrow(RESERVED_CARRIER_REFUSAL);

    const untypedDriver = createInMemorySQLite3Driver();
    await untypedDriver._executeRaw(
      `CREATE TABLE "wrong_untyped_kind" ("samples" NOT NULL ${listCheck})`
    );
    await expect(
      sqlite3MigrationDriver.introspect((sql, params) =>
        untypedDriver._executeRaw(sql, params)
      )
    ).rejects.toThrow(RESERVED_CARRIER_REFUSAL);
  });

  it("lets SQLite rewrite an inbound compound mapped reference before recreating the carrier", async () => {
    const parent = table(
      "decimal_parent",
      [textColumn("tenant_key"), scalarDecimal("amount_db")],
      { primaryKey: { columns: ["tenant_key", "amount_db"] } }
    );
    const child = table(
      "decimal_child",
      [textColumn("tenant_ref"), scalarDecimal("amount_ref")],
      {
        primaryKey: { columns: ["tenant_ref", "amount_ref"] },
        foreignKeys: [
          {
            name: "child_parent_fk",
            columns: ["tenant_ref", "amount_ref"],
            referencedTable: "decimal_parent",
            referencedColumns: ["tenant_key", "amount_db"],
          },
        ],
      }
    );
    const before: SchemaSnapshot = { tables: [parent, child] };
    const driver = createInMemorySQLite3Driver();
    await createSnapshotTables(driver, before);
    await driver._executeRaw(
      `INSERT INTO "decimal_parent" ("tenant_key","amount_db") VALUES ('tenant',120)`
    );
    await driver._executeRaw(
      `INSERT INTO "decimal_child" ("tenant_ref","amount_ref") VALUES ('tenant',120)`
    );

    const up: DiffOperation = {
      type: "renameColumn",
      tableName: "decimal_parent",
      from: "amount_db",
      to: "total_db",
    };
    const upDdl = sqlite3MigrationDriver.generateDDL(
      up,
      ddlContext("live", { currentSchema: before })
    );
    expect(upDdl.split(";\n")[0]).toBe(
      'ALTER TABLE "decimal_parent" RENAME COLUMN "amount_db" TO "total_db"'
    );
    await executeDdl(driver, upDdl);

    expect(await foreignKeys(driver, "decimal_child")).toEqual([
      {
        seq: 0,
        table: "decimal_parent",
        from: "tenant_ref",
        to: "tenant_key",
      },
      {
        seq: 1,
        table: "decimal_parent",
        from: "amount_ref",
        to: "total_db",
      },
    ]);
    expect((await driver._executeRaw("PRAGMA foreign_key_check")).rows).toEqual(
      []
    );

    const afterParent = {
      ...parent,
      columns: parent.columns.map((column) =>
        column.name === "amount_db" ? { ...column, name: "total_db" } : column
      ),
      primaryKey: { columns: ["tenant_key", "total_db"] },
    };
    const afterChild = {
      ...child,
      foreignKeys: child.foreignKeys.map((fk) => ({
        ...fk,
        referencedColumns: ["tenant_key", "total_db"],
      })),
    };
    const down = invertOperations([up], before).operations[0];
    if (down === undefined) throw new Error("missing automatic rename down");
    await executeDdl(
      driver,
      sqlite3MigrationDriver.generateDDL(
        down,
        ddlContext("live", {
          currentSchema: { tables: [afterParent, afterChild] },
        })
      )
    );
    expect((await foreignKeys(driver, "decimal_child"))[1]?.to).toBe(
      "amount_db"
    );
    expect((await driver._executeRaw("PRAGMA foreign_key_check")).rows).toEqual(
      []
    );
    await driver.disconnect();
  });

  it("keeps an inbound decimal rename when the child is recreated later in the batch", async () => {
    const parent = table(
      "decimal_replay_parent",
      [scalarDecimal("amount_db")],
      { primaryKey: { columns: ["amount_db"] } }
    );
    const child = table(
      "decimal_replay_child",
      [textColumn("id"), scalarDecimal("amount_ref"), textColumn("note")],
      {
        primaryKey: { columns: ["id"] },
        foreignKeys: [
          {
            name: "decimal_replay_child_parent_fk",
            columns: ["amount_ref"],
            referencedTable: "decimal_replay_parent",
            referencedColumns: ["amount_db"],
          },
        ],
      }
    );
    const before: SchemaSnapshot = { tables: [parent, child] };
    const operations: DiffOperation[] = [
      {
        type: "renameColumn",
        tableName: "decimal_replay_parent",
        from: "amount_db",
        to: "total_db",
      },
      {
        type: "alterColumn",
        tableName: "decimal_replay_child",
        columnName: "note",
        from: textColumn("note"),
        to: textColumn("note", true),
      },
    ];
    const driver = createInMemorySQLite3Driver();
    await createSnapshotTables(driver, before);
    await driver._executeRaw(
      `INSERT INTO "decimal_replay_parent" ("amount_db") VALUES (120)`
    );
    await driver._executeRaw(
      `INSERT INTO "decimal_replay_child" ("id","amount_ref","note") VALUES ('row',120,'kept')`
    );

    const statements = generateDDLStatements(
      operations,
      sqlite3MigrationDriver,
      before
    );
    await executeDDLStatements(driver, sqlite3MigrationDriver, statements);

    expect(await foreignKeys(driver, "decimal_replay_child")).toEqual([
      {
        seq: 0,
        table: "decimal_replay_parent",
        from: "amount_ref",
        to: "total_db",
      },
    ]);
    expect((await driver._executeRaw("PRAGMA foreign_key_check")).rows).toEqual(
      []
    );
    await driver.disconnect();
  });

  it("keeps an inbound table rename when the child is recreated later in the batch", async () => {
    const parent = table("table_replay_parent", [textColumn("id")], {
      primaryKey: { columns: ["id"] },
    });
    const child = table(
      "table_replay_child",
      [textColumn("id"), textColumn("parent_id"), textColumn("note")],
      {
        primaryKey: { columns: ["id"] },
        foreignKeys: [
          {
            name: "table_replay_child_parent_fk",
            columns: ["parent_id"],
            referencedTable: "table_replay_parent",
            referencedColumns: ["id"],
          },
        ],
      }
    );
    const before: SchemaSnapshot = { tables: [parent, child] };
    const operations: DiffOperation[] = [
      {
        type: "renameTable",
        from: "table_replay_parent",
        to: "table_replay_account",
      },
      {
        type: "alterColumn",
        tableName: "table_replay_child",
        columnName: "note",
        from: textColumn("note"),
        to: textColumn("note", true),
      },
    ];
    const driver = createInMemorySQLite3Driver();
    await createSnapshotTables(driver, before);
    await driver._executeRaw(
      `INSERT INTO "table_replay_parent" ("id") VALUES ('parent')`
    );
    await driver._executeRaw(
      `INSERT INTO "table_replay_child" ("id","parent_id","note") VALUES ('child','parent','kept')`
    );

    const statements = generateDDLStatements(
      operations,
      sqlite3MigrationDriver,
      before
    );
    await executeDDLStatements(driver, sqlite3MigrationDriver, statements);

    expect(await foreignKeys(driver, "table_replay_child")).toEqual([
      {
        seq: 0,
        table: "table_replay_account",
        from: "parent_id",
        to: "id",
      },
    ]);
    expect((await driver._executeRaw("PRAGMA foreign_key_check")).rows).toEqual(
      []
    );
    await driver.disconnect();
  });

  it("replays a table rename before rebuilding a renamed decimal column", async () => {
    const before: SchemaSnapshot = {
      tables: [
        table("decimal_replay_ledger", [
          textColumn("id"),
          scalarDecimal("amount"),
        ]),
      ],
    };
    const operations: DiffOperation[] = [
      {
        type: "renameTable",
        from: "decimal_replay_ledger",
        to: "decimal_replay_account",
      },
      {
        type: "renameColumn",
        tableName: "decimal_replay_account",
        from: "amount",
        to: "total",
      },
    ];
    const driver = createInMemorySQLite3Driver();
    await createSnapshotTables(driver, before);
    await driver._executeRaw(
      `INSERT INTO "decimal_replay_ledger" ("id","amount") VALUES ('row',120)`
    );

    await executeDDLStatements(
      driver,
      sqlite3MigrationDriver,
      generateDDLStatements(operations, sqlite3MigrationDriver, before)
    );

    const definition = await driver._executeRaw<{ sql: string }>(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='decimal_replay_account'`
    );
    expect(definition.rows[0]?.sql).toContain("viborm_decimal_total_10_2");
    expect(definition.rows[0]?.sql).not.toContain("viborm_decimal_amount_10_2");
    const stored = await driver._executeRaw<{ total: number }>(
      `SELECT "total" FROM "decimal_replay_account" WHERE "id" = 'row'`
    );
    expect(stored.rows).toEqual([{ total: 120 }]);
    await driver.disconnect();
  });

  it("updates a self-referential compound target and a separate outbound local column", async () => {
    const self = table(
      "decimal_self",
      [
        textColumn("tenant_key"),
        scalarDecimal("amount_db"),
        textColumn("parent_tenant", true),
        scalarDecimal("parent_amount", true),
      ],
      {
        primaryKey: { columns: ["tenant_key", "amount_db"] },
        foreignKeys: [
          {
            name: "self_parent_fk",
            columns: ["parent_tenant", "parent_amount"],
            referencedTable: "decimal_self",
            referencedColumns: ["tenant_key", "amount_db"],
          },
        ],
      }
    );
    const target = table("decimal_target", [scalarDecimal("target_amount")], {
      primaryKey: { columns: ["target_amount"] },
    });
    const outbound = table(
      "decimal_outbound",
      [textColumn("row_id"), scalarDecimal("amount_db")],
      {
        primaryKey: { columns: ["row_id"] },
        foreignKeys: [
          {
            name: "outbound_fk",
            columns: ["amount_db"],
            referencedTable: "decimal_target",
            referencedColumns: ["target_amount"],
          },
        ],
      }
    );
    const snapshot: SchemaSnapshot = { tables: [self, target, outbound] };
    const driver = createInMemorySQLite3Driver();
    await createSnapshotTables(driver, snapshot);
    await driver._executeRaw(
      `INSERT INTO "decimal_self" ("tenant_key","amount_db","parent_tenant","parent_amount") VALUES ('t',100,NULL,NULL),('t',200,'t',100)`
    );
    await driver._executeRaw(
      `INSERT INTO "decimal_target" ("target_amount") VALUES (100)`
    );
    await driver._executeRaw(
      `INSERT INTO "decimal_outbound" ("row_id","amount_db") VALUES ('row',100)`
    );

    await executeDdl(
      driver,
      sqlite3MigrationDriver.generateDDL(
        {
          type: "renameColumn",
          tableName: "decimal_self",
          from: "amount_db",
          to: "total_db",
        },
        ddlContext("live", { currentSchema: snapshot })
      )
    );
    expect((await foreignKeys(driver, "decimal_self"))[1]?.to).toBe("total_db");

    await executeDdl(
      driver,
      sqlite3MigrationDriver.generateDDL(
        {
          type: "renameColumn",
          tableName: "decimal_outbound",
          from: "amount_db",
          to: "total_db",
        },
        ddlContext("live", { currentSchema: snapshot })
      )
    );
    expect((await foreignKeys(driver, "decimal_outbound"))[0]?.from).toBe(
      "total_db"
    );
    expect((await driver._executeRaw("PRAGMA foreign_key_check")).rows).toEqual(
      []
    );
    await driver.disconnect();
  });

  it("rolls the native rename back when carrier recreation rejects a row", async () => {
    const driver = createInMemorySQLite3Driver();
    const before = createClient({
      schema: {
        ledger: s
          .model({
            id: s.string().id(),
            amount: s.decimal({ precision: 10, scale: 2 }),
          })
          .map("decimal_rename_rollback"),
      },
      driver,
    });
    await push(before, { force: true });
    await driver._executeRaw("PRAGMA ignore_check_constraints=ON");
    await driver._executeRaw(
      `INSERT INTO "decimal_rename_rollback" ("id","amount") VALUES ('row','corrupt')`
    );
    await driver._executeRaw("PRAGMA ignore_check_constraints=OFF");

    const after = createClient({
      schema: {
        ledger: s
          .model({
            id: s.string().id(),
            total: s.decimal({ precision: 10, scale: 2 }),
          })
          .map("decimal_rename_rollback"),
      },
      driver,
    });
    await expect(
      push(after, {
        force: true,
        resolve: (change) => {
          if (change.type === "ambiguous") return change.rename();
          if (change.type === "destructive") return change.proceed();
          return change.reject();
        },
      })
    ).rejects.toThrow();

    const columns = await driver._executeRaw<{ name: string }>(
      `PRAGMA table_info("decimal_rename_rollback")`
    );
    expect(columns.rows.map((column) => column.name)).toEqual(["id", "amount"]);
    const definition = await driver._executeRaw<{ sql: string }>(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='decimal_rename_rollback'`
    );
    expect(definition.rows[0]?.sql).toContain("viborm_decimal_amount_10_2");
    expect(definition.rows[0]?.sql).not.toContain("viborm_decimal_total_10_2");
    await after.$disconnect();
  });
});
