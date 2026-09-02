import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { describe, expect, test } from "vitest";

describe("SQLite3 provider statement metadata", () => {
  test("returns rows for CTE, PRAGMA, EXPLAIN, and every DML RETURNING form", async () => {
    const driver = new SQLite3Driver({ dataDir: ":memory:" });

    try {
      await driver._executeRaw(
        `CREATE TABLE "returning_events" ("id" INTEGER PRIMARY KEY, "note" TEXT NOT NULL)`
      );
      await driver._executeRaw(
        `INSERT INTO "returning_events" ("note") VALUES (?)`,
        ["returning parameter"]
      );

      const cte = await driver._executeRaw<{ value: number }>(
        `WITH "returning_cte" AS (SELECT 1 AS "value") SELECT "value" FROM "returning_cte"`
      );
      const leadingComment = await driver._executeRaw<{ value: number }>(
        `/* returning is only a leading comment */ SELECT 1 AS "value"`
      );
      const empty = await driver._executeRaw<{ value: number }>(
        `SELECT 1 AS "value" WHERE 0`
      );
      const pragma = await driver._executeRaw<{ name: string }>(
        `PRAGMA table_info("returning_events")`
      );
      const pragmaSetter = await driver._executeRaw<{
        journal_mode: string;
      }>("PRAGMA journal_mode = MEMORY");
      const nonReaderPragma = await driver._executeRaw(
        "PRAGMA foreign_keys = ON"
      );
      const explain = await driver._executeRaw(
        `EXPLAIN SELECT * FROM "returning_events"`
      );
      const inserted = await driver._executeRaw<{ id: number; note: string }>(
        `INSERT INTO "returning_events" ("note") VALUES ('inserted') RETURNING "id", "note"`
      );
      const updated = await driver._executeRaw<{ id: number; note: string }>(
        `UPDATE "returning_events" SET "note" = 'updated' WHERE "id" = 1 RETURNING "id", "note"`
      );
      const deleted = await driver._executeRaw<{ id: number }>(
        `DELETE FROM "returning_events" WHERE "id" = 1 RETURNING "id"`
      );
      const cteInsert = await driver._executeRaw(
        `WITH "returning_source"("note") AS (VALUES ('cte')) INSERT INTO "returning_events" ("note") SELECT "note" FROM "returning_source"`
      );
      const lineCommentInsert = await driver._executeRaw(
        "INSERT INTO returning_events (note) VALUES ('line') -- returning is only a comment\n"
      );

      expect(cte.rows).toEqual([{ value: 1 }]);
      expect(leadingComment.rows).toEqual([{ value: 1 }]);
      expect(empty).toEqual({ rows: [], rowCount: 0 });
      expect(pragma.rows.map((column) => column.name)).toEqual(["id", "note"]);
      expect(pragmaSetter.rows).toEqual([{ journal_mode: "memory" }]);
      expect(nonReaderPragma).toEqual({ rows: [], rowCount: 0 });
      expect(explain.rows.length).toBeGreaterThan(0);
      expect(inserted).toMatchObject({
        rows: [{ id: 2, note: "inserted" }],
        rowCount: 1,
      });
      expect(updated).toMatchObject({
        rows: [{ id: 1, note: "updated" }],
        rowCount: 1,
      });
      expect(deleted).toMatchObject({ rows: [{ id: 1 }], rowCount: 1 });
      expect(cteInsert).toEqual({ rows: [], rowCount: 1 });
      expect(lineCommentInsert).toEqual({ rows: [], rowCount: 1 });
    } finally {
      await driver.disconnect();
    }
  });

  test("does not expose a sticky inserted id on later UPDATE or DELETE results", async () => {
    const driver = new SQLite3Driver({ dataDir: ":memory:" });

    try {
      await driver._executeRaw(
        `CREATE TABLE "events" ("id" INTEGER PRIMARY KEY, "note" TEXT NOT NULL)`
      );
      await driver._executeRaw(`INSERT INTO "events" ("note") VALUES ('one')`);

      const updated = await driver._executeRaw(
        `UPDATE "events" SET "note" = 'two' WHERE "id" = 1`
      );
      const deleted = await driver._executeRaw(
        `DELETE FROM "events" WHERE "id" = 1`
      );

      expect(updated).toEqual({ rows: [], rowCount: 1 });
      expect(deleted).toEqual({ rows: [], rowCount: 1 });
    } finally {
      await driver.disconnect();
    }
  });
});

describe("SQLite3 public returning_events regression", () => {
  test("pushes the mapped table and creates a generated-id row", async () => {
    const event = s
      .model({
        id: s.int().id().increment(),
        note: s.string(),
      })
      .map("returning_events");
    const client = createClient({
      schema: { event },
      driver: new SQLite3Driver({ dataDir: ":memory:" }),
    });

    try {
      await syncLiveSchema(client);
      const created = await client.event.create({
        data: { note: "returning is ordinary data" },
      });

      expect(created).toEqual({ id: 1, note: "returning is ordinary data" });
      await expect(client.event.findMany({})).resolves.toEqual([created]);
    } finally {
      await client.$disconnect();
    }
  });
});
