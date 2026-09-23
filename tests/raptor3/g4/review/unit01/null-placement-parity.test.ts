import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import Database from "better-sqlite3";
import { describe, it } from "vitest";

/**
 * Q-O01 parity probe. `orderBy: { column: "asc" }` with NO `nulls` key: the
 * shipped engine emits the bare direction (each dialect's own default), the
 * candidate must answer the same rows in the same order on the same provider.
 */
const row = s
  .model({
    id: s.int().id(),
    weight: s.int().nullable(),
  })
  .map("np_rows");

const schema = { row };

function database(): Database.Database {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE np_rows(id INTEGER PRIMARY KEY, weight INTEGER)");
  const insert = db.prepare("INSERT INTO np_rows(id, weight) VALUES (?, ?)");
  for (const [id, weight] of [
    [1, 3],
    [2, null],
    [3, 1],
    [4, null],
    [5, 2],
  ] as [number, number | null][])
    insert.run(id, weight);
  return db;
}

describe("G4-01 review — default null placement parity", () => {
  it("answers an unqualified ascending order the same way the shipped engine does", async () => {
    const shippedDb = database();
    const shippedDriver = new SQLite3Driver({ client: shippedDb });
    const candidateDb = database();
    const candidateDriver = new SQLite3Driver({ client: candidateDb });
    try {
      const client = createClient({ schema, driver: shippedDriver }) as any;
      const shipped = (await client.row.findMany({
        orderBy: { weight: "asc" },
        select: { id: true },
      })) as { id: number }[];

      const engine = createCommandEngine({
        schema,
        driver: candidateDriver,
      });
      const candidate = (await engine.execute("row", "findMany", {
        orderBy: { weight: "asc" },
        select: { id: true },
      })) as { id: number }[];

      assert.deepEqual(
        candidate.map((r) => r.id),
        shipped.map((r) => r.id),
        `candidate ${JSON.stringify(candidate.map((r) => r.id))} vs shipped ${JSON.stringify(shipped.map((r) => r.id))}`
      );
    } finally {
      await shippedDriver.disconnect();
      shippedDb.close();
      await candidateDriver.disconnect();
      candidateDb.close();
    }
  });

  it("answers an unqualified descending order the same way the shipped engine does", async () => {
    const shippedDb = database();
    const shippedDriver = new SQLite3Driver({ client: shippedDb });
    const candidateDb = database();
    const candidateDriver = new SQLite3Driver({ client: candidateDb });
    try {
      const client = createClient({ schema, driver: shippedDriver }) as any;
      const shipped = (await client.row.findMany({
        orderBy: { weight: "desc" },
        select: { id: true },
      })) as { id: number }[];
      const engine = createCommandEngine({
        schema,
        driver: candidateDriver,
      });
      const candidate = (await engine.execute("row", "findMany", {
        orderBy: { weight: "desc" },
        select: { id: true },
      })) as { id: number }[];
      assert.deepEqual(
        candidate.map((r) => r.id),
        shipped.map((r) => r.id),
        `candidate ${JSON.stringify(candidate.map((r) => r.id))} vs shipped ${JSON.stringify(shipped.map((r) => r.id))}`
      );
    } finally {
      await shippedDriver.disconnect();
      shippedDb.close();
      await candidateDriver.disconnect();
      candidateDb.close();
    }
  });
});
