// biome-ignore lint/performance/noNamespaceImport: this contract audits the intentional runtime barrels

import { VibORM } from "@client/client";
// biome-ignore lint/performance/noNamespaceImport: this contract audits the intentional runtime barrels
import * as drivers from "@drivers";
import {
  BunSQLiteDriver,
  createClient as createBunSQLiteClient,
} from "@drivers/bun-sqlite";
import { createClient as createD1Client, D1Driver } from "@drivers/d1";
import { Driver } from "@drivers/driver";
// biome-ignore lint/performance/noNamespaceImport: this contract audits the intentional runtime barrels
import * as driverBase from "@drivers/exports";
import {
  createClient as createLibSQLClient,
  LibSQLDriver,
} from "@drivers/libsql";
import {
  createClient as createSQLite3Client,
  SQLite3Driver,
} from "@drivers/sqlite3";
import { afterEach, describe, expect, test, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
});

function driverFromWrapper(build: () => unknown): unknown {
  const create = vi.spyOn(VibORM, "create");
  build();
  const config = create.mock.calls[0]?.[0];
  if (!config) throw new Error("Expected the wrapper to compose a client");
  return config.driver;
}

describe("driver runtime export surface", () => {
  test("the custom-driver subpath exposes only its documented runtime owners", () => {
    expect(Object.keys(driverBase).sort()).toEqual([
      "CheckConstraintError",
      "ConnectionError",
      "Driver",
      "FeatureNotSupportedError",
      "ForeignKeyError",
      "NotNullConstraintError",
      "QueryError",
      "TransactionError",
      "UniqueConstraintError",
      "isRetryableError",
    ]);
    expect(driverBase.Driver).toBe(Driver);
  });

  test("the aggregate driver barrel exposes every shipped runtime driver", () => {
    expect(Object.keys(drivers).sort()).toEqual([
      "BunSQLDriver",
      "BunSQLiteDriver",
      "CheckConstraintError",
      "ConnectionError",
      "D1Driver",
      "Driver",
      "DriverError",
      "FeatureNotSupportedError",
      "ForeignKeyError",
      "LibSQLDriver",
      "MySQL2Driver",
      "NeonHTTPDriver",
      "NotNullConstraintError",
      "PGliteDriver",
      "PgDriver",
      "PlanetScaleDriver",
      "PostgresDriver",
      "QueryError",
      "SQLite3Driver",
      "TransactionBoundDriver",
      "TransactionError",
      "UniqueConstraintError",
      "isRetryableError",
      "isUniqueConstraintError",
      "unsupportedVector",
    ]);
    expect(drivers.Driver).toBe(Driver);
  });

  test.each([
    {
      name: "Bun SQLite",
      driver: BunSQLiteDriver,
      build: () => createBunSQLiteClient({ schema: {} }),
    },
    {
      name: "D1",
      driver: D1Driver,
      build: () =>
        Reflect.apply(createD1Client, undefined, [
          { database: Object.create(null), schema: {} },
        ]),
    },
    {
      name: "libSQL",
      driver: LibSQLDriver,
      build: () => createLibSQLClient({ schema: {} }),
    },
    {
      name: "SQLite3",
      driver: SQLite3Driver,
      build: () => createSQLite3Client({ schema: {} }),
    },
  ])("the $name convenience wrapper installs its concrete driver lazily", ({
    build,
    driver,
  }) => {
    const installed = driverFromWrapper(build);
    if (
      installed === null ||
      (typeof installed !== "object" && typeof installed !== "function")
    ) {
      throw new Error("Expected the wrapper to install a driver object");
    }

    expect(installed).toBeInstanceOf(driver);
    expect(Reflect.get(installed, "dialect")).toBe("sqlite");
  });
});
