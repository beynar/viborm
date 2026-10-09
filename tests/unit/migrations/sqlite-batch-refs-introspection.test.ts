import { getMigrationDriver } from "@migrations/drivers";
import { sqlite3MigrationDriver } from "@migrations/drivers/sqlite";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { d1EstateDriver } from "@tests/unit/migrations/_estate";
import { describe, expect, it } from "vitest";

describe("SQLite introspection and the batch reference scratch", () => {
  it("excludes only D1-owned tables on a D1-bound catalog reader", async () => {
    const database = createInMemorySQLite3Driver();
    try {
      for (const table of ["_cf_METADATA", "_cf_KV", "_cfX_notes", "users"])
        await database._executeRaw(
          `CREATE TABLE "${table}" ("id" TEXT PRIMARY KEY)`
        );
      const statements: string[] = [];
      const d1 = getMigrationDriver(d1EstateDriver());
      const snapshot = await d1.introspect((sql, params) => {
        statements.push(sql);
        return database._executeRaw(sql, params);
      });
      expect(snapshot.tables.map(({ name }) => name)).toEqual([
        "_cfX_notes",
        "users",
      ]);
      expect(statements.some((sql) => sql.includes('("_cf_METADATA")'))).toBe(
        false
      );
      expect(statements.some((sql) => sql.includes('("_cf_KV")'))).toBe(false);

      const ordinary = await sqlite3MigrationDriver.introspect((sql, params) =>
        database._executeRaw(sql, params)
      );
      expect(ordinary.tables.map(({ name }) => name)).toEqual([
        "_cfX_notes",
        "_cf_KV",
        "_cf_METADATA",
        "users",
      ]);
    } finally {
      await database.disconnect();
    }
  });

  it("leaves a main-schema __viborm_batch_refs out of the snapshot", async () => {
    // On a transport without temporary objects (D1) the engine's scratch is
    // an ordinary table in `main`; a snapshot that carried it would have push
    // and diff plan its drop.
    const driver = createInMemorySQLite3Driver();
    await driver._executeRaw(
      'CREATE TABLE "__viborm_batch_refs" ("batch_id" TEXT NOT NULL, "ref_key" TEXT NOT NULL, "ref_value" TEXT, PRIMARY KEY ("batch_id", "ref_key"))'
    );
    await driver._executeRaw('CREATE TABLE "users" ("id" TEXT PRIMARY KEY)');

    const snapshot = await sqlite3MigrationDriver.introspect((sql, params) =>
      driver._executeRaw(sql, params)
    );

    expect(snapshot.tables.map(({ name }) => name)).toEqual(["users"]);
  });
});
