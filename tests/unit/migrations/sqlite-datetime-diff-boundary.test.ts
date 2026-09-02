/**
 * SQLite DateTime's logical storage marker is available in authenticated V1
 * snapshots, but it cannot be recovered from live SQLite introspection.
 */

/** Live SQLite proof of DateTime diff provenance and adoption. */

import { createClient } from "@client/client";
import { createMigrationClient } from "@migrations/client";
import { MemoryEstateStorage } from "@migrations/storage/memory";
import { s, TYPES } from "@schema";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { describe, expect, test } from "vitest";

const TABLE = "datetime_diff_boundary_events";

function textSchema() {
  return {
    event: s.model({ id: s.string().id(), at: s.string() }).map(TABLE),
  };
}

function dateTimeTextSchema() {
  return {
    event: s
      .model({
        id: s.string().id(),
        at: s.dateTime(TYPES.SQLITE.DATETIME.TEXT),
      })
      .map(TABLE),
  };
}

function renamedDateTimeTextSchema() {
  return {
    event: s
      .model({
        id: s.string().id(),
        recordedAt: s.dateTime(TYPES.SQLITE.DATETIME.TEXT),
      })
      .map(TABLE),
  };
}

describe("SQLite DateTime diff provenance", () => {
  test("authenticated V1 snapshots detect same-form DateTime adoption", async () => {
    const storage = new MemoryEstateStorage();
    const driver = createInMemorySQLite3Driver();
    const before = createClient({ schema: textSchema(), driver });
    const beforeMigrations = createMigrationClient(before, { storage });
    const initial = await beforeMigrations.generate({ name: "text" });
    if (initial.stateId === null) throw new Error("expected initial state");
    await beforeMigrations.apply({ to: { id: initial.stateId } });
    await before.event.create({
      data: { id: "valid", at: "2026-08-30T12:34:56.789Z" },
    });

    const after = createClient({ schema: dateTimeTextSchema(), driver });
    const afterMigrations = createMigrationClient(after, { storage });
    const adopted = await afterMigrations.generate({ name: "datetime-text" });

    expect(adopted.operations).toEqual([
      expect.objectContaining({
        type: "alterColumn",
        tableName: TABLE,
        columnName: "at",
      }),
    ]);
    expect(adopted.sql).toContain("CASE WHEN");

    await afterMigrations.apply();
    await expect(after.event.findMany()).resolves.toEqual([
      { id: "valid", at: new Date("2026-08-30T12:34:56.789Z") },
    ]);
    await after.$disconnect();
  });

  test("unchanged live DateTime push does not churn", async () => {
    const driver = createInMemorySQLite3Driver();
    const client = createClient({ schema: dateTimeTextSchema(), driver });

    await syncLiveSchema(client, { force: true });

    expect((await syncLiveSchema(client, { force: true })).operations).toEqual(
      []
    );
    await client.$disconnect();
  });

  test("accepted V1 rename still validates same-form DateTime adoption", async () => {
    const storage = new MemoryEstateStorage();
    const driver = createInMemorySQLite3Driver();
    const before = createClient({ schema: textSchema(), driver });
    await createMigrationClient(before, { storage }).generate({ name: "text" });

    const after = createClient({
      schema: renamedDateTimeTextSchema(),
      driver,
    });
    const adopted = await createMigrationClient(after, { storage }).generate({
      name: "renamed-datetime-text",
      resolve: (change) =>
        change.type === "ambiguous" ? change.rename() : change.reject(),
    });

    expect(adopted.operations.map((operation) => operation.type)).toEqual([
      "renameColumn",
      "alterColumn",
    ]);
    expect(adopted.sql).toContain("CASE WHEN");
    await after.$disconnect();
  });
});
