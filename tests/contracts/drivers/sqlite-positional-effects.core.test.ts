/**
 * The better-sqlite3 positional read fetches INTEGER cells as numbers and,
 * when one is past ±2^53, reads the statement again exactly. Repeating a read
 * is harmless; repeating a write is not. A statement transform can turn a
 * collection SELECT into `UPDATE … RETURNING`, so the second read is only for
 * statements SQLite reports as read-only — a writing statement is read exactly
 * on its one execution.
 */

import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { s } from "@schema";
import { sql } from "@sql";
import { defineExtension } from "@src/index";
import { describe, expect, test } from "vitest";

const EXACT = 9_007_199_254_740_993n;

const item = s
  .model({ id: s.int().id(), big: s.bigInt(), n: s.int() })
  .map("item");
const schema = { item };

describe("sqlite3 positional reads past 2^53", () => {
  test("a transformed write runs once and still returns the exact integer", async () => {
    const driver = new SQLite3Driver();
    const client = createClient({ schema, driver });
    try {
      await driver._executeRaw(
        'CREATE TABLE "item" ("id" INTEGER PRIMARY KEY, "big" INTEGER NOT NULL, "n" INTEGER NOT NULL)'
      );
      await driver._executeRaw(`INSERT INTO "item" VALUES (1, ${EXACT}, 0)`);
      const bumping = client.$extends(
        defineExtension<typeof schema>()({
          name: "bump-on-read",
          statement: () =>
            sql`UPDATE "item" SET "n" = "n" + 1 RETURNING "id", "big", "n"`,
        })
      );

      await expect(bumping.item.findMany()).resolves.toEqual([
        { id: 1, big: EXACT, n: 1 },
      ]);
      const stored = await driver._executeRaw<{ n: number }>(
        'SELECT "n" FROM "item" WHERE "id" = 1'
      );
      expect(stored.rows).toEqual([{ n: 1 }]);
    } finally {
      await driver.disconnect();
    }
  });

  test("a read-only statement past 2^53 is still exact", async () => {
    const driver = new SQLite3Driver();
    const client = createClient({ schema, driver });
    try {
      await driver._executeRaw(
        'CREATE TABLE "item" ("id" INTEGER PRIMARY KEY, "big" INTEGER NOT NULL, "n" INTEGER NOT NULL)'
      );
      await driver._executeRaw(`INSERT INTO "item" VALUES (1, ${EXACT}, 0)`);
      await expect(client.item.findMany()).resolves.toEqual([
        { id: 1, big: EXACT, n: 0 },
      ]);
    } finally {
      await driver.disconnect();
    }
  });
});
