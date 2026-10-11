import { VibORM } from "@client/client";
// biome-ignore lint/performance/noNamespaceImport: this contract audits the intentional runtime barrels
import * as drivers from "@drivers";
import { createClient as createBunSQLClient } from "@drivers/bun-sql";
import {
  BunSQLiteDriver,
  createClient as createBunSQLiteClient,
} from "@drivers/bun-sqlite";
import { createClient as createD1Client, D1Driver } from "@drivers/d1";
import { Driver, TransactionBoundDriver } from "@drivers/driver";
// biome-ignore lint/performance/noNamespaceImport: this contract audits the intentional runtime barrels
import * as driverBase from "@drivers/exports";
import {
  createClient as createLibSQLClient,
  LibSQLDriver,
} from "@drivers/libsql";
import { createClient as createMySQL2Client } from "@drivers/mysql2";
import { createClient as createNeonHTTPClient } from "@drivers/neon-http";
import { createClient as createPgClient } from "@drivers/pg";
import { createClient as createPGliteClient } from "@drivers/pglite";
import { createClient as createPlanetScaleClient } from "@drivers/planetscale";
import { borrowPositionalResult } from "@drivers/positional-result";
import { createClient as createPostgresClient } from "@drivers/postgres";
import { sqliteResultParser } from "@drivers/shared";
import {
  createClient as createSQLite3Client,
  SQLite3Driver,
} from "@drivers/sqlite3";
import { ClientInitializationError } from "@errors";
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
      "SQLITE_MIGRATION_CAPABILITY",
      "TransactionError",
      "UniqueConstraintError",
      "isRetryableError",
      "sqliteResultParser",
    ]);
    expect(driverBase.Driver).toBe(Driver);
    expect(driverBase.sqliteResultParser).toBe(sqliteResultParser);
  });

  test("a transaction view owns no client: it never opens one, and closes none", async () => {
    const view = new TransactionBoundDriver(new SQLite3Driver({}), null);
    expect(() =>
      Reflect.apply(Reflect.get(view, "initClient"), view, [])
    ).toThrow("TransactionBoundDriver does not initialize clients");
    await expect(
      Reflect.apply(Reflect.get(view, "closeClient"), view, [])
    ).resolves.toBeUndefined();
  });

  test("a borrowed positional result is keyed by its columns", () => {
    expect(
      borrowPositionalResult({
        kind: "positional",
        columns: ["id", "name"],
        rows: [
          [1, "a"],
          [2, "b"],
        ],
      })
    ).toEqual({
      rows: [
        { id: 1, name: "a" },
        { id: 2, name: "b" },
      ],
      rowCount: 2,
    });
  });

  // platform-16: the key is refused before any provider is reached.
  test.each([
    ["bun-sql", createBunSQLClient],
    ["bun-sqlite", createBunSQLiteClient],
    ["d1", createD1Client],
    ["libsql", createLibSQLClient],
    ["mysql2", createMySQL2Client],
    ["neon-http", createNeonHTTPClient],
    ["pg", createPgClient],
    ["pglite", createPGliteClient],
    ["planetscale", createPlanetScaleClient],
    ["postgres", createPostgresClient],
    ["sqlite3", createSQLite3Client],
  ] as const)("viborm/%s refuses a configuration key it does not read", (name, create) => {
    const attempt = () =>
      Reflect.apply(create, undefined, [{ schema: {}, notAKey: true }]);
    expect(attempt).toThrow(ClientInitializationError);
    expect(attempt).toThrow(`viborm/${name} does not accept "notAKey"`);
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
