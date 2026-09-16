import assert from "node:assert/strict";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import Database from "better-sqlite3";
import { describe, it } from "vitest";

const place = s
  .model({
    id: s.int().id(),
    name: s.string(),
    at: s.point().nullable(),
  })
  .map("g4_places");

const schema = { place };

function createWorld() {
  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE g4_places(
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      at TEXT
    );
  `);
  const insert = database.prepare(
    "INSERT INTO g4_places(id, name, at) VALUES (?, ?, ?)"
  );
  insert.run(1, "paris", JSON.stringify({ longitude: 2.3522, latitude: 48.8566 }));
  insert.run(2, "tokyo", JSON.stringify({ longitude: 139.6917, latitude: 35.6895 }));
  insert.run(3, "nowhere", null);
  const driver = new SQLite3Driver({ client: database });
  return {
    database,
    driver,
    engine: createCommandEngine({ schema, driver }),
  };
}

describe("G4-01 GeoPoint tiers (Q-W07, SC-14)", () => {
  it("decodes a point and answers equality and bounds on a coordinate-tier provider", async () => {
    const world = createWorld();
    try {
      const rows = (await world.engine.execute("place", "findMany", {
        where: { id: 1 },
      })) as Record<string, unknown>[];
      assert.deepEqual(rows[0]!.at, { longitude: 2.3522, latitude: 48.8566 });

      const equal = (await world.engine.execute("place", "findMany", {
        where: { at: { equals: { longitude: 2.3522, latitude: 48.8566 } } },
        select: { id: true },
      })) as Record<string, unknown>[];
      assert.deepEqual(equal, [{ id: 1 }]);

      const within = (await world.engine.execute("place", "findMany", {
        where: {
          at: {
            within: { bounds: { south: 40, west: -10, north: 60, east: 20 } },
          },
        },
        select: { id: true },
      })) as Record<string, unknown>[];
      assert.deepEqual(within, [{ id: 1 }]);

      const absent = (await world.engine.execute("place", "findMany", {
        where: { at: null },
        select: { id: true },
      })) as Record<string, unknown>[];
      assert.deepEqual(absent, [{ id: 3 }]);
    } finally {
      await world.driver.disconnect();
      world.database.close();
    }
  });

  it("refuses a distance predicate with the provider capability refusal", async () => {
    const world = createWorld();
    try {
      await assert.rejects(
        world.engine.execute("place", "findMany", {
          where: {
            at: { distance: { to: { longitude: 2.3, latitude: 48.8 }, lte: 1000 } },
          },
        }),
        (error: Error) => {
          assert.equal(error.constructor.name, "FeatureNotSupportedError");
          assert.match(error.message, /GeoPoint distance is not supported/);
          return true;
        }
      );
    } finally {
      await world.driver.disconnect();
      world.database.close();
    }
  });
});
