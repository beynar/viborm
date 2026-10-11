/**
 * How the stock D1 and libSQL drivers bind under SQLite positive admission
 * (the rest of it is `sqlite-migration-capability.core.test.ts`).
 *
 * Kept apart because it names the libSQL driver module, which the in-memory
 * SQLite exception does not extend to. Nothing here opens a database: the
 * libSQL driver connects lazily, and binding and admission run before any I/O.
 */

import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { SQLITE_MIGRATION_CAPABILITY } from "@drivers/driver";
import { LibSQLDriver } from "@drivers/libsql";
import { VibORMErrorCode } from "@src/errors";
import { admitLiveMigrationCapability } from "@src/migrations/admission";
import { getMigrationDriver } from "@src/migrations/drivers";
import { LibSQLMigrationDriver } from "@src/migrations/drivers/libsql";
import { describe, expect, test } from "vitest";
import { RecordingDriver } from "./_estate";

function refusalCode(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? Reflect.get(error, "code") : error;
  }
  return "admitted";
}

describe("SQLite positive admission: the stock D1 and libSQL bindings", () => {
  test("D1 and libSQL bind by name for reads and stay refused for effects", () => {
    for (const execution of [
      new RecordingDriver("sqlite", "d1", new SQLiteAdapter()),
      new LibSQLDriver({ databaseUrl: ":memory:" }),
    ]) {
      const driver = getMigrationDriver(execution);
      expect(
        refusalCode(() =>
          admitLiveMigrationCapability(driver, "read-only", "status()")
        )
      ).toBe("admitted");
      expect(
        refusalCode(() =>
          admitLiveMigrationCapability(driver, "effectful", "push()")
        )
      ).toBe(VibORMErrorCode.DRIVER_NOT_SUPPORTED);
    }
  });

  test("a declaring libSQL subclass binds to sqlite3, never to libsql's unvalidated native ALTER COLUMN", () => {
    class DeclaredLibSQLDriver extends LibSQLDriver {
      override readonly sqliteMigrationCapability = SQLITE_MIGRATION_CAPABILITY;
    }
    const declared = getMigrationDriver(
      new DeclaredLibSQLDriver({ databaseUrl: ":memory:" })
    );
    expect(declared).not.toBeInstanceOf(LibSQLMigrationDriver);
    expect(declared.driverName).toBe("sqlite3");
    expect(
      refusalCode(() =>
        admitLiveMigrationCapability(declared, "effectful", "apply()")
      )
    ).toBe("admitted");
    // The libsql implementation stays reachable only undeclared: read-only.
    expect(
      getMigrationDriver(new LibSQLDriver({ databaseUrl: ":memory:" }))
    ).toBeInstanceOf(LibSQLMigrationDriver);
  });
});
