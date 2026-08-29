import { VibORMErrorCode } from "@src/errors";
import {
  assertControlTablesAuthentic,
  createControlTableSQL,
  DEFAULT_CONTROL_BASE,
  ensureControlTables,
  inspectControlPresence,
  refusePartialControl,
} from "@src/migrations/control";
import type { BoundMigrationDriver } from "@src/migrations/drivers";
import { getMigrationDriver } from "@src/migrations/drivers";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { describe, expect, test } from "vitest";
import {
  controlCatalogAnswer,
  mysqlEstateDriver,
  pgEstateDriver,
  type RecordingDriver,
  sqliteEstateDriver,
} from "./_estate";

const dialects: readonly [string, () => RecordingDriver][] = [
  ["SQLite", sqliteEstateDriver],
  ["PostgreSQL", () => pgEstateDriver("tenant")],
  ["MySQL", () => mysqlEstateDriver({ namespace: "tenant", attested: true })],
];

describe.each(dialects)("%s control bootstrap", (_name, createDriver) => {
  test("recovers when log-table creation fails after the empty state table", async () => {
    const driver = createDriver();
    let statePresent = false;
    let logPresent = false;
    const migrationDriver = commandWithStateDefinition(
      getMigrationDriver(driver),
      false,
      () => logPresent
    );
    let failFirstLogCreate = true;
    driver.respond = (sql, params) => {
      const catalog = controlCatalogAnswer(sql, params, {
        state: statePresent,
        log: logPresent,
      });
      if (catalog) return catalog;
      if (
        sql.startsWith("SELECT sql FROM sqlite_master") &&
        sql.includes("type = 'table'")
      ) {
        return [
          {
            sql: "CREATE TABLE _viborm_migration_state (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), payload TEXT NOT NULL)",
          },
        ];
      }
      if (
        sql.includes("pg_get_constraintdef") ||
        sql.includes("information_schema.CHECK_CONSTRAINTS")
      ) {
        return [{ definition: "CHECK (singleton = 1)" }];
      }
      if (
        sql.includes("SELECT payload FROM") &&
        sql.includes("_viborm_migration_state")
      ) {
        return [];
      }
      if (
        sql.startsWith("CREATE TABLE") &&
        sql.includes("_viborm_migration_state")
      ) {
        statePresent = true;
        return [];
      }
      if (
        sql.startsWith("CREATE TABLE") &&
        sql.includes("_viborm_migration_log")
      ) {
        if (failFirstLogCreate) {
          failFirstLogCreate = false;
          return new Error("log create interrupted");
        }
        logPresent = true;
        return [];
      }
      return [];
    };

    await expect(
      ensureControlTables(driver, migrationDriver, DEFAULT_CONTROL_BASE)
    ).rejects.toThrow();
    expect(
      await inspectControlPresence(
        driver,
        migrationDriver,
        DEFAULT_CONTROL_BASE
      )
    ).toEqual({ kind: "recoverable-state-only" });

    await ensureControlTables(driver, migrationDriver, DEFAULT_CONTROL_BASE);
    expect(
      await inspectControlPresence(
        driver,
        migrationDriver,
        DEFAULT_CONTROL_BASE
      )
    ).toEqual({ kind: "present" });
  });

  test("still refuses a missing ledger beside an existing marker", async () => {
    const driver = createDriver();
    const migrationDriver = commandWithStateDefinition(
      getMigrationDriver(driver)
    );
    driver.respond = (sql, params) => {
      const catalog = controlCatalogAnswer(sql, params, {
        state: true,
        log: false,
      });
      if (catalog) return catalog;
      if (
        sql.startsWith("SELECT sql FROM sqlite_master") &&
        sql.includes("type = 'table'")
      ) {
        return [
          {
            sql: "CREATE TABLE _viborm_migration_state (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), payload TEXT NOT NULL)",
          },
        ];
      }
      if (
        sql.includes("pg_get_constraintdef") ||
        sql.includes("information_schema.CHECK_CONSTRAINTS")
      ) {
        return [{ definition: "CHECK (singleton = 1)" }];
      }
      if (
        sql.includes("SELECT payload FROM") &&
        sql.includes("_viborm_migration_state")
      ) {
        return [{ payload: "occupied" }];
      }
      return [];
    };

    const presence = await inspectControlPresence(
      driver,
      migrationDriver,
      DEFAULT_CONTROL_BASE
    );
    expect(presence).toEqual({ kind: "missing-table", table: "log" });
    expect(() => refusePartialControl(presence)).toThrowError(
      expect.objectContaining({
        code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      })
    );
  });

  test("refuses an empty state-table collision before bootstrap", async () => {
    const driver = createDriver();
    const migrationDriver = commandWithStateDefinition(
      getMigrationDriver(driver),
      true
    );
    driver.respond = (sql, params) => {
      const catalog = controlCatalogAnswer(sql, params, {
        state: true,
        log: false,
      });
      if (catalog) return catalog;
      return [];
    };

    await expect(
      inspectControlPresence(driver, migrationDriver, DEFAULT_CONTROL_BASE)
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      message: expect.stringContaining("unexpected definition"),
    });
    expect(
      driver.statements.some((sql) => sql.startsWith("CREATE TABLE"))
    ).toBe(false);
  });

  test("refuses an empty state table without the singleton check", async () => {
    const driver = createDriver();
    const migrationDriver = commandWithStateDefinition(
      getMigrationDriver(driver)
    );
    driver.respond = (sql, params) => {
      const catalog = controlCatalogAnswer(sql, params, {
        state: true,
        log: false,
      });
      if (catalog) return catalog;
      if (sql.startsWith("SELECT sql FROM sqlite_master")) {
        return [
          {
            sql: "CREATE TABLE _viborm_migration_state (singleton INTEGER PRIMARY KEY, payload TEXT NOT NULL)",
          },
        ];
      }
      return [];
    };

    await expect(
      inspectControlPresence(driver, migrationDriver, DEFAULT_CONTROL_BASE)
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      message: expect.stringContaining("unexpected definition"),
    });
    expect(
      driver.statements.some((sql) => sql.startsWith("CREATE TABLE"))
    ).toBe(false);
  });

  test("refuses a present pair whose ledger primary key is missing", async () => {
    const driver = createDriver();
    const migrationDriver = commandWithStateDefinition(
      getMigrationDriver(driver),
      false,
      () => true,
      true
    );
    driver.respond = (sql, params) => {
      const catalog = controlCatalogAnswer(sql, params, {
        state: true,
        log: true,
      });
      if (catalog) return catalog;
      if (
        sql.startsWith("SELECT sql FROM sqlite_master") &&
        sql.includes("type = 'table'")
      ) {
        return [
          {
            sql: "CREATE TABLE _viborm_migration_state (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), payload TEXT NOT NULL)",
          },
        ];
      }
      if (
        sql.includes("pg_get_constraintdef") ||
        sql.includes("information_schema.CHECK_CONSTRAINTS")
      ) {
        return [{ definition: "CHECK (singleton = 1)" }];
      }
      return [];
    };

    await expect(
      assertControlTablesAuthentic(
        driver,
        migrationDriver,
        DEFAULT_CONTROL_BASE
      )
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      message: expect.stringContaining("unexpected definition"),
    });
  });

  test("refuses executable attachments on an exact control pair", async () => {
    const driver = createDriver();
    const migrationDriver = commandWithStateDefinition(
      getMigrationDriver(driver),
      false,
      () => true
    );
    driver.respond = (sql, params) => {
      if (sql.includes("AS attached")) return [{ attached: 1 }];
      const catalog = controlCatalogAnswer(sql, params, {
        state: true,
        log: true,
      });
      if (catalog) return catalog;
      if (
        sql.startsWith("SELECT sql FROM sqlite_master") &&
        sql.includes("type = 'table'")
      ) {
        return [
          {
            sql: "CREATE TABLE _viborm_migration_state (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), payload TEXT NOT NULL)",
          },
        ];
      }
      if (
        sql.includes("pg_get_constraintdef") ||
        sql.includes("information_schema.CHECK_CONSTRAINTS")
      ) {
        return [{ definition: "CHECK (singleton = 1)" }];
      }
      return [];
    };

    await expect(
      assertControlTablesAuthentic(
        driver,
        migrationDriver,
        DEFAULT_CONTROL_BASE
      )
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      message: expect.stringContaining("executable attachments"),
    });
  });
});

function commandWithStateDefinition(
  driver: BoundMigrationDriver,
  malformed = false,
  hasLog: () => boolean = () => false,
  malformedLog = false
): BoundMigrationDriver {
  const command: BoundMigrationDriver = Object.create(driver);
  const dialect = driver.target.dialect;
  const tableName = "_viborm_migration_state";
  Object.defineProperty(command, "introspect", {
    value: async () => ({
      tables: [
        {
          name: tableName,
          columns: [
            {
              name: "singleton",
              type:
                dialect === "postgresql"
                  ? "int4"
                  : dialect === "mysql"
                    ? "INT"
                    : "INTEGER",
              nullable: false,
            },
            {
              name: malformed ? "intruder" : "payload",
              type: "TEXT",
              nullable: false,
            },
          ],
          primaryKey: {
            name: dialect === "mysql" ? "PRIMARY" : `${tableName}_pkey`,
            columns: ["singleton"],
          },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        ...(hasLog()
          ? [
              {
                name: "_viborm_migration_log",
                columns: [
                  {
                    name: "event_id",
                    type: dialect === "mysql" ? "VARCHAR(64)" : "TEXT",
                    nullable: false,
                  },
                  {
                    name: "attempt_id",
                    type: dialect === "mysql" ? "VARCHAR(64)" : "TEXT",
                    nullable: false,
                  },
                  {
                    name: "kind",
                    type: dialect === "mysql" ? "VARCHAR(32)" : "TEXT",
                    nullable: false,
                  },
                  { name: "payload", type: "TEXT", nullable: false },
                ],
                ...(malformedLog
                  ? {}
                  : {
                      primaryKey: {
                        name:
                          dialect === "mysql"
                            ? "PRIMARY"
                            : "_viborm_migration_log_pkey",
                        columns: ["event_id"],
                      },
                    }),
                indexes: [],
                foreignKeys: [],
                uniqueConstraints: [],
              },
            ]
          : []),
      ],
    }),
  });
  return command;
}

describe("live SQLite control bootstrap", () => {
  test("accepts only the exact empty state table created by bootstrap", async () => {
    const driver = createInMemorySQLite3Driver();
    const command = getMigrationDriver(driver);
    const sql = createControlTableSQL(command, DEFAULT_CONTROL_BASE);
    await driver._executeRaw(sql.state);

    await expect(
      inspectControlPresence(driver, command, DEFAULT_CONTROL_BASE)
    ).resolves.toEqual({ kind: "recoverable-state-only" });
    await driver._disconnect();
  });

  test("refuses a real empty collision without the singleton check", async () => {
    const driver = createInMemorySQLite3Driver();
    const command = getMigrationDriver(driver);
    await driver._executeRaw(
      'CREATE TABLE "_viborm_migration_state" (singleton INTEGER PRIMARY KEY, payload TEXT NOT NULL)'
    );

    await expect(
      inspectControlPresence(driver, command, DEFAULT_CONTROL_BASE)
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
    });
    await driver._disconnect();
  });

  test("refuses a state-only table with a trigger before recovery effects", async () => {
    const driver = createInMemorySQLite3Driver();
    const command = getMigrationDriver(driver);
    const sql = createControlTableSQL(command, DEFAULT_CONTROL_BASE);
    await driver._executeRaw(sql.state);
    await driver._executeRaw(
      `CREATE TRIGGER reject_control_insert BEFORE INSERT ON "_viborm_migration_state" BEGIN SELECT RAISE(ABORT, 'blocked'); END`
    );

    await expect(
      ensureControlTables(driver, command, DEFAULT_CONTROL_BASE)
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      message: expect.stringContaining("executable attachments"),
    });
    await expect(
      driver._executeRaw<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = ?",
        ["reject_control_insert"]
      )
    ).resolves.toMatchObject({ rows: [{ name: "reject_control_insert" }] });
    await expect(
      driver._executeRaw<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        ["_viborm_migration_log"]
      )
    ).resolves.toMatchObject({ rows: [] });
    await driver._disconnect();
  });

  test("refuses a present control pair whose log lacks its primary key", async () => {
    const driver = createInMemorySQLite3Driver();
    const command = getMigrationDriver(driver);
    const sql = createControlTableSQL(command, DEFAULT_CONTROL_BASE);
    await driver._executeRaw(sql.state);
    await driver._executeRaw(
      `CREATE TABLE "_viborm_migration_log" (event_id TEXT NOT NULL, attempt_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL)`
    );

    await expect(
      assertControlTablesAuthentic(driver, command, DEFAULT_CONTROL_BASE)
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      message: expect.stringContaining("unexpected definition"),
    });
    await driver._disconnect();
  });
});
