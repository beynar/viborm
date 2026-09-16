/**
 * G4-03 independent review probe — observers that throw, and read members in
 * an array transaction on an INTERACTIVE driver (the control for the
 * batch-only divergence in `route-array-reads.review.test.ts`).
 *
 * The review brief asks explicitly for "an observer that throws"; the unit's
 * LX-14/LX-15 oracles only use an observer that succeeds.
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
  .map("g4r_obs_authors");

const schema = { author };

type WorldClient = VibORMClient<{
  driver: SQLite3Driver;
  schema: typeof schema;
}>;

const closers: (() => Promise<void>)[] = [];

async function createWorld(route: "shipped" | "candidate") {
  const database = new Database(":memory:");
  const driver = new SQLite3Driver({ client: database });
  const config = { driver, schema };
  const client = (
    route === "shipped"
      ? createClient(config)
      : VibORM.create(config, createCandidateRoute)
  ) as WorldClient;
  const migration = await syncLiveSchema(client);
  if (!migration.applied) throw new Error("schema did not apply");
  closers.push(async () => {
    await client.$disconnect();
    database.close();
  });
  return { client, database, driver };
}

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function outcome<T>(run: () => PromiseLike<T>): Promise<string> {
  try {
    return `ok:${JSON.stringify(await run())}`;
  } catch (error) {
    return `${(error as Error).constructor.name}:${(error as Error).message}`;
  }
}

describe("G4-03 review — observer failures and interactive read arrays", () => {
  test("an observer that throws leaves the same public outcome on both routes", async () => {
    const results: Record<string, string> = {};
    const stored: Record<string, unknown[]> = {};
    for (const route of ["shipped", "candidate"] as const) {
      const world = await createWorld(route);
      const client = world.client.$extends({
        name: "throwing-observer",
        observe() {
          throw new Error("observer exploded");
        },
      });
      results[route] = await outcome(() =>
        client.author.create({
          data: { email: "throwing@example.test", name: "Boom" },
        })
      );
      stored[route] = world.database
        .prepare("SELECT email FROM g4r_obs_authors ORDER BY id")
        .all();
    }
    assert.equal(
      results.candidate,
      results.shipped,
      `candidate=${results.candidate}\nshipped=${results.shipped}`
    );
    assert.deepEqual(
      stored.candidate,
      stored.shipped,
      `candidate=${JSON.stringify(stored.candidate)} shipped=${JSON.stringify(stored.shipped)}`
    );
  });

  test("a read member in an array transaction on an interactive driver behaves the same on both routes", async () => {
    const results: Record<string, string> = {};
    for (const route of ["shipped", "candidate"] as const) {
      const world = await createWorld(route);
      await world.client.author.create({
        data: { email: "interactive-read@example.test", name: "Ada" },
      });
      results[route] = await outcome(() =>
        world.client.$transaction([
          world.client.author.findMany({ select: { email: true } }),
          world.client.author.create({
            data: { email: "interactive-write@example.test", name: "Grace" },
          }),
        ])
      );
    }
    assert.equal(
      results.candidate,
      results.shipped,
      `candidate=${results.candidate}\nshipped=${results.shipped}`
    );
  });
});
