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
import { sqliteResultParser } from "@drivers/shared";
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

function installedDriver(build: () => unknown): object {
  const installed = driverFromWrapper(build);
  if (
    installed === null ||
    (typeof installed !== "object" && typeof installed !== "function")
  ) {
    throw new Error("Expected the wrapper to install a driver object");
  }
  return installed as object;
}

/** Every SQLite convenience wrapper the package ships, and what it installs. */
const SQLITE_WRAPPERS = [
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
];

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

  test.each(
    SQLITE_WRAPPERS
  )("the $name convenience wrapper installs its concrete driver lazily", ({
    build,
    driver,
  }) => {
    const installed = installedDriver(build);

    expect(installed).toBeInstanceOf(driver);
    expect(Reflect.get(installed, "dialect")).toBe("sqlite");
  });

  test.each(
    SQLITE_WRAPPERS
  )("the $name driver publishes the shipped SQLite result parser", ({
    build,
  }) => {
    // One parser for the whole family, so what it owns it owns for all four
    // drivers — and since D-35 it owns row VALUES only: the meaning of a
    // `count`/`exist` answer belongs to the engine's decoder, which asks for
    // its own `_count` alias and reads it back
    // (`engine/query/parity-decoding.core.test.ts`, the D-35 cell).
    expect(Reflect.get(installedDriver(build), "result")).toBe(
      sqliteResultParser
    );
  });
});
