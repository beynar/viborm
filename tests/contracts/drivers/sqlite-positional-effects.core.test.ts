/**
 * A statement is executed once. The better-sqlite3 positional read must not
 * repeat a statement to recover exact integers past ±2^53: a statement
 * transform can turn the collection SELECT into `UPDATE … RETURNING`, and even
 * a SELECT that SQLite reports read-only may call an application function with
 * an observable effect. Exact integers are read on the one execution.
 */

import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { s } from "@schema";
import { raw, sql } from "@sql";
import { defineExtension } from "@src/index";
import Database from "better-sqlite3";
import { describe, expect, test, vi } from "vitest";

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

  test("a transformed write that returns nothing runs once and reads no rows", async () => {
    const driver = new SQLite3Driver();
    const client = createClient({ schema, driver });
    try {
      await driver._executeRaw(
        'CREATE TABLE "item" ("id" INTEGER PRIMARY KEY, "big" INTEGER NOT NULL, "n" INTEGER NOT NULL)'
      );
      await driver._executeRaw(`INSERT INTO "item" VALUES (1, ${EXACT}, 0)`);
      const bumping = client.$extends(
        defineExtension<typeof schema>()({
          name: "bump-silently",
          statement: () => sql`UPDATE "item" SET "n" = "n" + 1`,
        })
      );
      await expect(bumping.item.findMany()).resolves.toEqual([]);
      const stored = await driver._executeRaw<{ n: number }>(
        'SELECT "n" FROM "item" WHERE "id" = 1'
      );
      expect(stored.rows).toEqual([{ n: 1 }]);
    } finally {
      await driver.disconnect();
    }
  });

  test("a read-only statement calling an effectful function runs once", async () => {
    // SQLite reports this SELECT read-only, but the application function it
    // calls has an observable effect: read-only is not purity.
    const database = new Database(":memory:");
    let ticks = 0;
    database.function("tick", () => ++ticks);
    const driver = new SQLite3Driver({ client: database });
    const client = createClient({ schema, driver });
    try {
      const ticking = client.$extends(
        defineExtension<typeof schema>()({
          name: "tick-on-read",
          statement: () =>
            sql`SELECT tick() AS "id", ${raw(String(EXACT))} AS "big", 0 AS "n"`,
        })
      );
      await expect(ticking.item.findMany()).resolves.toEqual([
        { id: 1, big: EXACT, n: 0 },
      ]);
      expect(ticks).toBe(1);
    } finally {
      await driver.disconnect();
    }
  });

  test("a plain read past 2^53 is still exact", async () => {
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

  test("a cached statement reprepared after a schema change reads its new columns", async () => {
    const driver = new SQLite3Driver();
    const client = createClient({ schema, driver });
    try {
      await driver._executeRaw(
        'CREATE TABLE "item" ("id" INTEGER PRIMARY KEY, "big" INTEGER NOT NULL, "n" INTEGER NOT NULL)'
      );
      await driver._executeRaw(`INSERT INTO "item" VALUES (1, ${EXACT}, 0)`);
      const starred = client.$extends(
        defineExtension<typeof schema>()({
          name: "select-star",
          statement: () => sql`SELECT * FROM "item"`,
        })
      );
      await expect(starred.item.findMany()).resolves.toEqual([
        { id: 1, big: EXACT, n: 0 },
      ]);
      // SQLite reprepares the cached statement on its next run, so `*` now
      // names four columns; metadata read before that run still says three.
      await driver._executeRaw(
        'ALTER TABLE "item" ADD COLUMN "label" TEXT NOT NULL DEFAULT \'x\''
      );
      await expect(starred.item.findMany()).resolves.toEqual([
        { id: 1, big: EXACT, n: 0 },
      ]);
    } finally {
      await driver.disconnect();
    }
  });

  test("a hook on the shared parser before the driver module loads is still a hook", async () => {
    vi.resetModules();
    const { sqliteResultParser } = await import("@drivers/shared");
    sqliteResultParser.parseResult = (rawResult, operation, next) => {
      const parsed = next(rawResult, operation);
      return Array.isArray(parsed)
        ? parsed.map((row) => ({ ...row, n: 101 }))
        : parsed;
    };
    try {
      const { SQLite3Driver: FreshDriver } = await import("@drivers/sqlite3");
      const { createClient: freshCreateClient } = await import(
        "@client/client"
      );
      const { s: fresh } = await import("@schema");
      const freshItem = fresh
        .model({ id: fresh.int().id(), big: fresh.bigInt(), n: fresh.int() })
        .map("item");
      const driver = new FreshDriver();
      const client = freshCreateClient({ schema: { item: freshItem }, driver });
      try {
        await driver._executeRaw(
          'CREATE TABLE "item" ("id" INTEGER PRIMARY KEY, "big" INTEGER NOT NULL, "n" INTEGER NOT NULL)'
        );
        await driver._executeRaw('INSERT INTO "item" VALUES (1, 1, 0)');
        await expect(client.item.findMany()).resolves.toEqual([
          { id: 1, big: 1n, n: 101 },
        ]);
      } finally {
        await driver.disconnect();
      }
    } finally {
      sqliteResultParser.parseResult = undefined;
    }
  });
});
