import assert from "node:assert/strict";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import Database from "better-sqlite3";
import { describe, it } from "vitest";

const counter = s
  .model({
    id: s.int().id(),
    // The member name `_count` is reserved (F010); the column name is not.
    tally: s.int().nullable().map("_count"),
  })
  .map("g4_count_output_slots");

describe("G4-01 count output slots", () => {
  it("distinguishes a selected field stored in the _count column from the synthetic count slot", async () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE g4_count_output_slots(
        id INTEGER PRIMARY KEY,
        _count INTEGER
      );
      INSERT INTO g4_count_output_slots(id, _count)
      VALUES (1, 10), (2, NULL);
    `);
    const driver = new SQLite3Driver({ client: database });
    const engine = createCommandEngine({ schema: { counter }, driver });

    try {
      assert.deepEqual(
        await engine.execute("counter", "count", {
          select: { _all: true, tally: true },
        }),
        { _all: 2, tally: 1 }
      );
      assert.equal(await engine.execute("counter", "count", {}), 2);
      assert.equal(await engine.execute("counter", "exist", {}), true);
      assert.equal(
        await engine.execute("counter", "exist", { where: { id: 99 } }),
        false
      );
    } finally {
      await driver.disconnect();
      database.close();
    }
  });
});
