import { createClient } from "@client/client";
import type { QueryExecutionContext } from "@drivers/driver";
import { SQLite3Driver } from "@drivers/sqlite3";
import { s } from "@schema";
import { sql } from "@sql";
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";

const entry = s.model({ id: s.int().id(), label: s.string() }).map("entries");

function databaseLabelled(label: string): Database.Database {
  const database = new Database(":memory:");
  database.exec(
    'CREATE TABLE "entries" ("id" INTEGER PRIMARY KEY, "label" TEXT NOT NULL)'
  );
  database.prepare('INSERT INTO "entries" VALUES (1, ?)').run(label);
  return database;
}

/**
 * A caller's driver that owns acquisition: it keeps the base connection open
 * through `super.getClient()` and hands every caller a second, scoped database.
 */
class ScopedSQLite3Driver extends SQLite3Driver {
  acquisitions = 0;
  private readonly scoped: Database.Database;

  constructor(scoped: Database.Database, connected?: Database.Database) {
    super(connected ? { client: connected } : {});
    this.scoped = scoped;
  }

  protected override async getClient(
    context?: QueryExecutionContext
  ): Promise<Database.Database> {
    this.acquisitions += 1;
    await super.getClient(context);
    return this.scoped;
  }
}

const labelOf = (database: Database.Database) =>
  database
    .prepare('SELECT "label" FROM "entries" WHERE "id" = 1')
    .pluck()
    .get();

describe("a driver's getClient override owns every statement's connection", () => {
  test.each([
    ["connected at construction", true],
    ["connected by its first statement", false],
  ] as const)("typed and raw statements ask the override (%s)", async (_label, supplied) => {
    const scoped = databaseLabelled("scoped");
    const fallback = databaseLabelled("default");
    const driver = new ScopedSQLite3Driver(
      scoped,
      supplied ? fallback : undefined
    );
    const client = createClient({ schema: { entry }, driver });
    const asksOnce = async <T>(statement: () => PromiseLike<T>): Promise<T> => {
      const before = driver.acquisitions;
      const result = await statement();
      expect(driver.acquisitions).toBe(before + 1);
      return result;
    };
    try {
      for (let round = 0; round < 3; round++) {
        await expect(asksOnce(() => client.entry.findMany())).resolves.toEqual([
          { id: 1, label: "scoped" },
        ]);
        await expect(
          asksOnce(() => client.entry.findUnique({ where: { id: 1 } }))
        ).resolves.toEqual({ id: 1, label: "scoped" });
        await expect(
          asksOnce(() => client.$queryRaw(sql`SELECT "label" FROM "entries"`))
        ).resolves.toEqual([{ label: "scoped" }]);
      }
      await expect(
        asksOnce(() =>
          client.$executeRaw(sql`UPDATE "entries" SET "label" = ${"raw"}`)
        )
      ).resolves.toBe(1);
      expect(labelOf(scoped)).toBe("raw");
      expect(labelOf(fallback)).toBe("default");
    } finally {
      await driver.disconnect();
      scoped.close();
      fallback.close();
    }
  });

  test("statements inside a transaction run on the transaction the override opened", async () => {
    const scoped = databaseLabelled("scoped");
    const fallback = databaseLabelled("default");
    const driver = new ScopedSQLite3Driver(scoped, fallback);
    const client = createClient({ schema: { entry }, driver });
    try {
      await client.entry.findMany();
      const before = driver.acquisitions;
      const seen = await client.$transaction(async (tx) => {
        await tx.entry.update({ where: { id: 1 }, data: { label: "in-tx" } });
        await tx.$executeRaw(
          sql`UPDATE "entries" SET "label" = "label" || '!'`
        );
        return tx.entry.findMany();
      });
      expect(seen).toEqual([{ id: 1, label: "in-tx!" }]);
      // One acquisition opens the transaction; its statements use the tx.
      expect(driver.acquisitions).toBe(before + 1);
      expect(labelOf(scoped)).toBe("in-tx!");
      expect(labelOf(fallback)).toBe("default");
    } finally {
      await driver.disconnect();
      scoped.close();
      fallback.close();
    }
  });
});
