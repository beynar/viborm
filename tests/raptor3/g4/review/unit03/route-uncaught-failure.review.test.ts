/**
 * G4-03 second follow-up review probe (repair-2 verification).
 *
 * Every D-1 state/outcome witness written so far — the reviewer's probe and the
 * pin the repair added — CATCHES the failing member inside the callback. The
 * common shape is the uncaught one: the failure propagates out of
 * `$transaction(callback)`. If the region changed that shape too, the recorded
 * divergence would be wider than "the caller catches and keeps going".
 *
 * Both cases here must AGREE on the two routes. A failure is a divergence the
 * unit's records do not carry.
 */

import assert from "node:assert/strict";
import { VibORM, type VibORMClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCandidateRoute } from "@query-engine/raptor3/route/client-route";
import { s } from "@schema";
import { createClient } from "@src/index";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { afterEach, describe, test } from "vitest";

const author = s
  .model({
    id: s.int().id().increment(),
    email: s.string().unique(),
    name: s.string(),
  })
  .map("g4r_unc_authors");

const schema = { author };

type WorldClient = VibORMClient<{
  driver: SQLite3Driver;
  schema: typeof schema;
}>;

interface World {
  readonly client: WorldClient;
  readonly database: Database.Database;
}

const worlds: World[] = [];

async function createWorld(route: "candidate" | "shipped"): Promise<World> {
  const database = new Database(":memory:");
  const driver = new SQLite3Driver({ client: database });
  const config = { driver, schema };
  const client: WorldClient =
    route === "shipped"
      ? createClient(config)
      : VibORM.create(config, createCandidateRoute);
  const migration = await syncLiveSchema(client);
  if (!migration.applied) throw new Error("schema did not apply");
  const world: World = { client, database };
  worlds.push(world);
  return world;
}

afterEach(async () => {
  for (const world of worlds.splice(0)) {
    await world.client.$disconnect();
    world.database.close();
  }
});

function storedAuthors(world: World): unknown[] {
  return world.database
    .prepare("SELECT email FROM g4r_unc_authors ORDER BY id")
    .all();
}

async function onBothRoutes<T>(
  scenario: (world: World) => Promise<T>
): Promise<{ candidate: T; shipped: T }> {
  const shipped = await scenario(await createWorld("shipped"));
  const candidate = await scenario(await createWorld("candidate"));
  return { candidate, shipped };
}

describe("G4-03 repair-2 — the uncaught shape of divergence D-1", () => {
  test("an UNCAUGHT failing statement-atomic write inside $transaction(callback) rolls everything back on both routes", async () => {
    const observations = await onBothRoutes(async (world) => {
      await world.client.author.create({
        data: { email: "taken@example.test", name: "Taken" },
      });
      let outer: string | undefined;
      try {
        await world.client.$transaction(async (tx) => {
          await tx.author.create({
            data: { email: "kept@example.test", name: "Kept" },
          });
          await tx.author.create({
            data: { email: "taken@example.test", name: "Duplicate" },
          });
        });
      } catch (error) {
        outer = (error as Error).constructor.name;
      }
      return { outer, stored: storedAuthors(world) };
    });

    assert.equal(observations.shipped.outer, "UniqueConstraintError");
    assert.deepEqual(observations.shipped.stored, [
      { email: "taken@example.test" },
    ]);
    assert.equal(
      observations.candidate.outer,
      observations.shipped.outer,
      `candidate=${observations.candidate.outer} shipped=${observations.shipped.outer}`
    );
    assert.deepEqual(
      observations.candidate.stored,
      observations.shipped.stored,
      `candidate=${JSON.stringify(observations.candidate.stored)} shipped=${JSON.stringify(observations.shipped.stored)}`
    );
  });

  test("a CAUGHT failing write whose caller then throws its own error rolls everything back on both routes", async () => {
    const observations = await onBothRoutes(async (world) => {
      await world.client.author.create({
        data: { email: "taken@example.test", name: "Taken" },
      });
      let outer: string | undefined;
      try {
        await world.client.$transaction(async (tx) => {
          await tx.author.create({
            data: { email: "kept@example.test", name: "Kept" },
          });
          try {
            await tx.author.create({
              data: { email: "taken@example.test", name: "Duplicate" },
            });
          } catch {
            throw new Error("caller aborts");
          }
        });
      } catch (error) {
        outer = (error as Error).message;
      }
      return { outer, stored: storedAuthors(world) };
    });

    assert.equal(observations.shipped.outer, "caller aborts");
    assert.deepEqual(observations.shipped.stored, [
      { email: "taken@example.test" },
    ]);
    assert.equal(observations.candidate.outer, observations.shipped.outer);
    assert.deepEqual(
      observations.candidate.stored,
      observations.shipped.stored,
      `candidate=${JSON.stringify(observations.candidate.stored)} shipped=${JSON.stringify(observations.shipped.stored)}`
    );
  });
});
