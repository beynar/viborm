/**
 * SQLite positive admission.
 *
 * Effectful migration work runs only on a SQLite driver that DECLARES the
 * migration capability (`sqliteMigrationCapability`). The stock sqlite3 and
 * bun-sqlite drivers declare it; D1 and libSQL do not. A custom SQLite driver
 * binds to the sqlite3 migration implementation only by declaring it — there is
 * no dialect-default fallback any more — so an undeclared one is refused before
 * any effect, and the same driver with the declaration migrates.
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { createClient } from "@client/client";
import { Driver, SQLITE_MIGRATION_CAPABILITY } from "@drivers/driver";
import { sqliteResultParser } from "@drivers/shared/sqlite-utils";
import { runTransactionLifecycle } from "@drivers/shared/transactions";
import { SQLite3Driver } from "@drivers/sqlite3";
import type { QueryResult } from "@drivers/types";
import { s } from "@schema";
import { VibORMErrorCode } from "@src/errors";
import { admitLiveMigrationCapability } from "@src/migrations/admission";
import { getMigrationDriver } from "@src/migrations/drivers";
import { pushV1 } from "@src/migrations/push-v1";
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { RecordingDriver } from "./_estate";

type SqliteHandle = Database.Database;

const ROWS = 10_000;

const fields = {
  id: s.string().id(),
  sku: s.string().unique(),
  name: s.string(),
  status: s.enum(["draft", "active", "archived"]).default("draft"),
  price: s.int(),
  stock: s.int().default(0),
  weight: s.number().nullable(),
  attributes: s.json().nullable(),
  note: s.string().nullable(),
  country: s.string().default("FR"),
  featured: s.boolean().default(false),
  rank: s.int().nullable(),
  publishedAt: s.dateTime().nullable(),
  createdAt: s.dateTime().now(),
  updatedAt: s.dateTime().updatedAt(),
};
const before = { item: s.model(fields) };
const after = {
  item: s.model({ ...fields, barcode: s.string().nullable() }),
};

/**
 * A complete, transactional SQLite driver over better-sqlite3, written the way
 * the custom-driver docs show, that declares nothing beyond the Driver contract.
 */
class CustomSqliteDriver extends Driver<SqliteHandle, SqliteHandle> {
  readonly adapter: DatabaseAdapter = new SQLiteAdapter();
  override readonly result = sqliteResultParser;
  private readonly db: SqliteHandle;

  constructor(db: SqliteHandle) {
    super("sqlite", "custom-sqlite");
    this.db = db;
  }

  protected initClient(): Promise<SqliteHandle> {
    return Promise.resolve(this.db);
  }

  protected closeClient(): Promise<void> {
    return Promise.resolve();
  }

  protected execute<T>(
    client: SqliteHandle,
    sql: string,
    params: unknown[]
  ): Promise<QueryResult<T>> {
    return this.executeRaw<T>(client, sql, params);
  }

  protected executeRaw<T>(
    client: SqliteHandle,
    sql: string,
    params: unknown[] = []
  ): Promise<QueryResult<T>> {
    const statement = client.prepare(sql);
    const values = params.map((value) => {
      if (typeof value === "boolean") return value ? 1 : 0;
      if (value instanceof Date) return value.toISOString();
      return value;
    });
    if (statement.reader) {
      // The provider boundary, typed exactly as the stock sqlite3 driver types it.
      const rows = statement.all(...values) as T[];
      return Promise.resolve({ rows, rowCount: rows.length });
    }
    const { changes } = statement.run(...values);
    return Promise.resolve({ rows: [], rowCount: changes });
  }

  protected transaction<T>(
    client: SqliteHandle,
    fn: (tx: SqliteHandle) => Promise<T>
  ): Promise<T> {
    return runTransactionLifecycle({
      begin: () => client.exec("BEGIN IMMEDIATE"),
      callback: () => fn(client),
      commit: () => client.exec("COMMIT"),
      rollback: () => client.exec("ROLLBACK"),
    });
  }
}

class DeclaredCustomSqliteDriver extends CustomSqliteDriver {
  override readonly sqliteMigrationCapability = SQLITE_MIGRATION_CAPABILITY;
}

/** A populated database at `before`: 10k rows over a 15-field model. */
async function populatedDatabase(): Promise<SqliteHandle> {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  const client = createClient({
    schema: before,
    driver: new SQLite3Driver({ client: db }),
  });
  await pushV1(client);
  await client.item.createMany({
    data: Array.from({ length: ROWS }, (_, index) => ({
      id: `item-${index}`,
      sku: `SKU-${index}`,
      name: `Item ${index}`,
      price: index,
      attributes: { color: index % 2 === 0 ? "red" : "blue" },
    })),
  });
  return db;
}

function physicalState(db: SqliteHandle) {
  return {
    schema: db
      .prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name")
      .all(),
    rows: db.prepare('SELECT count(*) AS n FROM "item"').get(),
  };
}

function refusalCode(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? Reflect.get(error, "code") : error;
  }
  return "admitted";
}

describe("SQLite positive admission", () => {
  test("an undeclared custom driver is refused before any effect on a populated database", async () => {
    const db = await populatedDatabase();
    const untouched = physicalState(db);

    const client = createClient({
      schema: after,
      driver: new CustomSqliteDriver(db),
    });
    await expect(pushV1(client)).rejects.toMatchObject({
      code: VibORMErrorCode.DRIVER_NOT_SUPPORTED,
    });

    expect(physicalState(db)).toEqual(untouched);
    db.close();
  });

  test("the same driver migrates once it declares the capability", async () => {
    const db = await populatedDatabase();

    const client = createClient({
      schema: after,
      driver: new DeclaredCustomSqliteDriver(db),
    });
    await expect(pushV1(client)).resolves.toMatchObject({
      outcome: "applied",
    });

    const columns = db
      .prepare("SELECT name FROM pragma_table_info('item')")
      .pluck()
      .all();
    expect(columns).toContain("barcode");
    expect(physicalState(db).rows).toEqual({ n: ROWS });
    db.close();
  });

  test("the stock sqlite3 driver declares the capability and stays admitted", () => {
    const driver = getMigrationDriver(
      new SQLite3Driver({ dataDir: ":memory:" })
    );
    expect(driver.sqliteMigrationCapability).toEqual(
      SQLITE_MIGRATION_CAPABILITY
    );
    expect(
      refusalCode(() =>
        admitLiveMigrationCapability(driver, "effectful", "apply()")
      )
    ).toBe("admitted");
  });

  test("a stock driver name is a binding, not the declaration", () => {
    // Named like the stock driver, so it binds (generation and reads work),
    // but it declares nothing, so effectful work is refused.
    const driver = getMigrationDriver(
      new RecordingDriver("sqlite", "sqlite3", new SQLiteAdapter())
    );
    expect(
      refusalCode(() =>
        admitLiveMigrationCapability(driver, "read-only", "status()")
      )
    ).toBe("admitted");
    expect(
      refusalCode(() =>
        admitLiveMigrationCapability(driver, "effectful", "apply()")
      )
    ).toBe(VibORMErrorCode.DRIVER_NOT_SUPPORTED);
  });

  test("an undeclared custom driver has no migration binding at all", () => {
    const db = new Database(":memory:");
    expect(
      refusalCode(() => getMigrationDriver(new CustomSqliteDriver(db)))
    ).toBe(VibORMErrorCode.DRIVER_NOT_SUPPORTED);
    db.close();
  });

  test.each([
    ["foreignKeys", "none"],
    ["reservedTablePrefixes", "_cf_"],
    ["exclusion", "none"],
  ])("a declaration whose %s claim is %j is no declaration", (key, value) => {
    const db = new Database(":memory:");
    const driver = new CustomSqliteDriver(db);
    // A JavaScript driver can write any value; only the exact claim counts.
    Object.defineProperty(driver, "sqliteMigrationCapability", {
      value: { ...SQLITE_MIGRATION_CAPABILITY, [key]: value },
    });
    expect(refusalCode(() => getMigrationDriver(driver))).toBe(
      VibORMErrorCode.DRIVER_NOT_SUPPORTED
    );
    db.close();
  });
});
