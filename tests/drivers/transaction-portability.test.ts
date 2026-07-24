import { BunSQLDriver } from "@drivers/bun-sql";
import { BunSQLiteDriver } from "@drivers/bun-sqlite";
import { D1Driver } from "@drivers/d1";
import { LibSQLDriver } from "@drivers/libsql";
import { MySQL2Driver } from "@drivers/mysql2";
import { NeonHTTPDriver } from "@drivers/neon-http";
import { PgDriver } from "@drivers/pg";
import { PGliteDriver } from "@drivers/pglite";
import { PlanetScaleDriver } from "@drivers/planetscale";
import { PostgresDriver } from "@drivers/postgres";
import { SQLite3Driver } from "@drivers/sqlite3";
import { describe, expect, test, vi } from "vitest";

interface DriverFactory {
  readonly name: string;
  readonly create: () => object;
}

const advertisedDrivers: readonly DriverFactory[] = [
  { name: "pg", create: () => new PgDriver() },
  { name: "postgres.js", create: () => new PostgresDriver() },
  { name: "PGlite", create: () => new PGliteDriver() },
  { name: "Neon HTTP", create: () => new NeonHTTPDriver() },
  { name: "Bun SQL", create: () => new BunSQLDriver() },
  { name: "mysql2", create: () => new MySQL2Driver() },
  { name: "PlanetScale", create: () => new PlanetScaleDriver() },
  { name: "SQLite3", create: () => new SQLite3Driver() },
  { name: "libSQL", create: () => new LibSQLDriver() },
  {
    name: "D1 binding",
    create: () => Reflect.construct(D1Driver, [{ database: {} }]),
  },
  { name: "Bun SQLite", create: () => new BunSQLiteDriver() },
];

describe("portable transaction entry conformance", () => {
  test.each(
    advertisedDrivers
  )("$name rejects every removed option before callback or provider dispatch", async ({
    create,
  }) => {
    const driver = create();
    const callback = vi.fn(async () => undefined);
    const initClient = vi.fn(async () => ({}));
    const providerTransaction = vi.fn(async () => undefined);
    const providerBatch = vi.fn(async () => []);
    Reflect.set(driver, "initClient", initClient);
    Reflect.set(driver, "transaction", providerTransaction);
    Reflect.set(driver, "executeBatch", providerBatch);

    await expect(
      Reflect.apply(Reflect.get(driver, "_transaction"), driver, [
        callback,
        { isolationLevel: "Serializable" },
      ])
    ).rejects.toMatchObject({ code: "V5005" });
    await expect(
      Reflect.apply(Reflect.get(driver, "_executeBatch"), driver, [
        [],
        { timeout: 1 },
      ])
    ).rejects.toMatchObject({ code: "V5005" });

    expect(callback).not.toHaveBeenCalled();
    expect(initClient).not.toHaveBeenCalled();
    expect(providerTransaction).not.toHaveBeenCalled();
    expect(providerBatch).not.toHaveBeenCalled();
  });

  test.each(
    advertisedDrivers
  )("$name accepts an empty batch without opening a provider", async ({
    create,
  }) => {
    const driver = create();
    const initClient = vi.fn(async () => ({}));
    const providerTransaction = vi.fn(async () => undefined);
    const providerBatch = vi.fn(async () => []);
    Reflect.set(driver, "initClient", initClient);
    Reflect.set(driver, "transaction", providerTransaction);
    Reflect.set(driver, "executeBatch", providerBatch);

    await expect(
      Reflect.apply(Reflect.get(driver, "_executeBatch"), driver, [[]])
    ).resolves.toEqual([]);
    expect(initClient).not.toHaveBeenCalled();
    expect(providerTransaction).not.toHaveBeenCalled();
    expect(providerBatch).not.toHaveBeenCalled();
  });

  test.each([
    {
      name: "D1 binding",
      create: () => Reflect.construct(D1Driver, [{ database: {} }]),
    },
    { name: "Neon HTTP", create: () => new NeonHTTPDriver() },
  ])("$name protected callback fallback fails closed", async ({ create }) => {
    const driver = create();
    const callback = vi.fn(async () => undefined);

    await expect(
      Reflect.apply(Reflect.get(driver, "transaction"), driver, [{}, callback])
    ).rejects.toMatchObject({ name: "TransactionError" });
    expect(callback).not.toHaveBeenCalled();
  });
});
