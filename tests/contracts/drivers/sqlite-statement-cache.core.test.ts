import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { s } from "@schema";
import { sql } from "@sql";
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";

const entry = s.model({ id: s.int().id() }).map("entries");

function seededDatabase(): Database.Database {
  const database = new Database(":memory:");
  database.exec(
    'CREATE TABLE "entries" ("id" INTEGER PRIMARY KEY); INSERT INTO "entries" VALUES (7)'
  );
  return database;
}

describe("SQLite3 statement reuse", () => {
  test("one native statement per SQL text, with each path keeping its row mode", async () => {
    const database = seededDatabase();
    const statement = Object.getPrototypeOf(database.prepare("SELECT 1"));
    const all = statement.all;
    const used = new Set<object>();
    statement.all = function (this: object, ...values: unknown[]) {
      used.add(this);
      return all.apply(this, values);
    };
    const driver = new SQLite3Driver({ client: database });
    try {
      const client = createClient({ schema: { entry }, driver });
      for (let round = 0; round < 3; round++)
        await expect(client.entry.findMany()).resolves.toEqual([{ id: 7 }]);
      expect(used.size).toBe(1);
      // The keyed path reads the same text as objects, not positional arrays.
      const keyed = await driver._execute(sql`SELECT "id" FROM "entries"`);
      expect(keyed.rows).toEqual([{ id: 7n }]);
    } finally {
      statement.all = all;
      database.close();
    }
  });

  test("a database whose prepare was replaced sees every statement", async () => {
    const database = seededDatabase();
    const prepared: string[] = [];
    const prepare = database.prepare.bind(database);
    database.prepare = ((text: string) => {
      prepared.push(text);
      return prepare(text);
    }) as typeof database.prepare;
    const driver = new SQLite3Driver({ client: database });
    try {
      const client = createClient({ schema: { entry }, driver });
      await client.entry.findMany();
      await client.entry.findMany();
      expect(prepared).toHaveLength(2);
      expect(prepared[0]).toBe(prepared[1]);
    } finally {
      database.close();
    }
  });
});
