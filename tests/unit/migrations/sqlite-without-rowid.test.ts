/** `.withoutRowid()`: created, kept by recreations, read back, and seen as drift. */

import { createClient } from "@client/client";
import { createMigrationClient } from "@migrations/dialects/all";
import { serializeModels } from "@migrations/serializer";
import { MemoryEstateStorage } from "@migrations/storage/memory";
import {
  encodeSnapshot,
  parseSnapshotDocument,
} from "@migrations/v1-parse-snapshot";
import { type AnyScalar, s } from "@schema";
import { validateSchema } from "@schema/validation";
import { postgresMigrationDriver } from "@src/migrations/drivers/postgres";
import { sqlite3MigrationDriver } from "@src/migrations/drivers/sqlite";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { describe, expect, it } from "vitest";
import { syncLiveSchema } from "../../fixtures/sync-schema";

const textValue = () =>
  s
    .model({ prop: s.string(), v: s.string(), page: s.string() })
    .id(["prop", "v", "page"])
    .map("p_text");

const tableSql = async (
  driver: ReturnType<typeof createInMemorySQLite3Driver>
) =>
  (
    await driver._executeRaw<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE name = 'p_text'"
    )
  ).rows[0]?.sql;

describe("SQLite WITHOUT ROWID tables", () => {
  it("creates the table WITHOUT ROWID and reads it back as converged", async () => {
    const driver = createInMemorySQLite3Driver();
    const client = createClient({
      schema: { pText: textValue().withoutRowid() },
      driver,
    });
    try {
      await syncLiveSchema(client as never);
      expect(await tableSql(driver)).toMatch(/\)\s*WITHOUT ROWID$/);
      const again = await syncLiveSchema(client as never, { dryRun: true });
      expect(again.operations).toEqual([]);
    } finally {
      await client.$disconnect();
    }
  });

  it("keeps the option when another change rebuilds the table", async () => {
    const driver = createInMemorySQLite3Driver();
    const clustered = (note: AnyScalar) =>
      s
        .model({ prop: s.string(), v: s.string(), page: s.string(), note })
        .id(["prop", "v", "page"])
        .map("p_text")
        .withoutRowid();
    const before = createClient({
      schema: { pText: clustered(s.string().nullable()) },
      driver,
    });
    await syncLiveSchema(before as never);
    await driver._executeRaw(
      "INSERT INTO p_text (prop, v, page, note) VALUES ('a', 'b', 'c', 'n')"
    );
    // NULL to NOT NULL: SQLite rebuilds the table.
    const after = createClient({
      schema: { pText: clustered(s.string().default("x")) },
      driver,
    });
    try {
      const applied = await syncLiveSchema(after as never);
      expect(applied.operations.map(({ type }) => type)).toEqual([
        "alterColumn",
      ]);
      expect(await tableSql(driver)).toMatch(/"note" TEXT NOT NULL/);
      expect(await tableSql(driver)).toMatch(/\)\s*WITHOUT ROWID$/);
      expect((await driver._executeRaw("SELECT * FROM p_text")).rows).toEqual([
        { prop: "a", v: "b", page: "c", note: "n" },
      ]);
    } finally {
      await after.$disconnect();
    }
  });

  it("sees a lost or gained option as a change, and rebuilds the table", async () => {
    const driver = createInMemorySQLite3Driver();
    const plain = createClient({ schema: { pText: textValue() }, driver });
    await syncLiveSchema(plain as never);
    await driver._executeRaw(
      "INSERT INTO p_text (prop, v, page) VALUES ('a', 'b', 'c')"
    );
    const clustered = createClient({
      schema: { pText: textValue().withoutRowid() },
      driver,
    });
    try {
      const gained = await syncLiveSchema(clustered as never);
      expect(gained.operations.map(({ type }) => type)).toEqual([
        "dropPrimaryKey",
        "addPrimaryKey",
      ]);
      expect(await tableSql(driver)).toMatch(/\)\s*WITHOUT ROWID$/);
      expect((await driver._executeRaw("SELECT * FROM p_text")).rows).toEqual([
        { prop: "a", v: "b", page: "c" },
      ]);
      // The plain declaration now finds the option the database holds.
      const lost = await syncLiveSchema(plain as never, { dryRun: true });
      expect(lost.operations.map(({ type }) => type)).toEqual([
        "dropPrimaryKey",
        "addPrimaryKey",
      ]);
    } finally {
      await clustered.$disconnect();
    }
  });

  it("makes apply's destination proof refuse a table rebuilt without it", async () => {
    const driver = createInMemorySQLite3Driver();
    const client = createClient({
      schema: { pText: textValue().withoutRowid() },
      driver,
    });
    const migrations = createMigrationClient(client, {
      storage: new MemoryEstateStorage(),
    });
    try {
      await migrations.generate({ name: "base" });
      await migrations.apply();
      await driver._executeRaw(
        'CREATE TABLE "p_text_old" ("prop" TEXT NOT NULL, "v" TEXT NOT NULL, "page" TEXT NOT NULL, PRIMARY KEY ("prop", "v", "page"))'
      );
      await driver._executeRaw("DROP TABLE p_text");
      await driver._executeRaw('ALTER TABLE "p_text_old" RENAME TO "p_text"');
      await expect(migrations.verify()).rejects.toMatchObject({
        code: "V11014",
      });
    } finally {
      await client.$disconnect();
    }
  });
});

describe("withoutRowid in the snapshot", () => {
  it("is SQLite's alone, and absent leaves the snapshot unchanged", () => {
    const migrationDriver = sqlite3MigrationDriver;
    const plain = serializeModels({ pText: textValue() }, { migrationDriver });
    expect(JSON.stringify(plain)).not.toContain("withoutRowid");
    const clustered = serializeModels(
      { pText: textValue().withoutRowid() },
      { migrationDriver }
    );
    expect(clustered.tables[0]!.primaryKey).toMatchObject({
      withoutRowid: true,
    });
    const postgres = serializeModels(
      { pText: textValue().withoutRowid() },
      { migrationDriver: postgresMigrationDriver }
    );
    expect(JSON.stringify(postgres)).not.toContain("withoutRowid");
  });

  it("admits only `true` in a stored snapshot", () => {
    const table = {
      name: "p_text",
      columns: [{ name: "prop", type: "TEXT", nullable: false }],
      primaryKey: { columns: ["prop"], withoutRowid: false },
      indexes: [],
      foreignKeys: [],
      uniqueConstraints: [],
    };
    const { bytes, snapshotHash } = encodeSnapshot({
      tables: [table],
    } as never);
    expect(() => parseSnapshotDocument(bytes, snapshotHash)).toThrow(
      /withoutRowid must be true/
    );
    const kept = encodeSnapshot({
      tables: [
        { ...table, primaryKey: { columns: ["prop"], withoutRowid: true } },
      ],
    } as never);
    expect(
      parseSnapshotDocument(kept.bytes, kept.snapshotHash).tables[0]!.primaryKey
    ).toEqual({ columns: ["prop"], withoutRowid: true });
  });

  it("refuses an incremented ID (M008)", () => {
    const counter = s.model({ id: s.int().id().increment() }).withoutRowid();
    expect(validateSchema({ counter }).errors).toContainEqual(
      expect.objectContaining({ code: "M008", model: "counter", field: "id" })
    );
  });
});
