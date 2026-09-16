import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import Database from "better-sqlite3";
import { describe, it } from "vitest";

/**
 * Q-O02 probe. `select: { <point>: { _distance: { to } } }` is an admitted
 * PROJECTION (`src/validation/model/core/select.ts:193`). The provider here is
 * the coordinate tier, which has no `distance`: the answer must be the named
 * capability refusal, never the raw column.
 */
const place = s
  .model({ id: s.int().id(), name: s.string(), at: s.point().nullable() })
  .map("dp_places");

const schema = { place };

function createWorld() {
  const database = new Database(":memory:");
  database.exec(
    "CREATE TABLE dp_places(id INTEGER PRIMARY KEY, name TEXT NOT NULL, at TEXT)"
  );
  database
    .prepare("INSERT INTO dp_places(id, name, at) VALUES (?, ?, ?)")
    .run(1, "paris", JSON.stringify({ longitude: 2.3522, latitude: 48.8566 }));
  const driver = new SQLite3Driver({ client: database });
  return {
    database,
    driver,
    engine: createCommandEngine({ schema, driver }),
    client: createClient({ schema, driver }) as any,
  };
}

describe("G4-01 review — distance projection", () => {
  it("answers a distance projection the way the shipped engine does", async () => {
    const world = createWorld();
    try {
      const args = {
        where: { id: 1 },
        select: {
          id: true,
          at: { _distance: { to: { longitude: 0, latitude: 0 } } },
        },
      };
      let shipped: unknown;
      let shippedError: Error | undefined;
      try {
        shipped = await world.client.place.findMany(args);
      } catch (error) {
        shippedError = error as Error;
      }
      let candidate: unknown;
      let candidateError: Error | undefined;
      try {
        candidate = await world.engine.execute("place", "findMany", args);
      } catch (error) {
        candidateError = error as Error;
      }
      assert.equal(
        candidateError === undefined,
        shippedError === undefined,
        `shipped ${shippedError ? `threw ${shippedError.message}` : `returned ${JSON.stringify(shipped)}`}; candidate ${candidateError ? `threw ${candidateError.message}` : `returned ${JSON.stringify(candidate)}`}`
      );
      if (shippedError === undefined)
        assert.deepEqual(candidate, shipped);
    } finally {
      await world.driver.disconnect();
      world.database.close();
    }
  });
});
