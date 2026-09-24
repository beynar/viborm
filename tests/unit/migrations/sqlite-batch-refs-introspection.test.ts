import { sqlite3MigrationDriver } from "@migrations/drivers/sqlite";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { describe, expect, it } from "vitest";

describe("SQLite introspection and the batch reference scratch", () => {
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
