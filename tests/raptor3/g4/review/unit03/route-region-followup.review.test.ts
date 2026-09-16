/**
 * G4-03 follow-up review probes (r3 repair verification).
 *
 * The r3 repair does not remove the operation-scoped region the route opens
 * inside a caller transaction; it NAMES it (divergence D-1) and pins today's
 * shape. These probes ask what else that region can be seen to do, beyond the
 * unit-kind sequence the pin already asserts:
 *
 *  1. a READ inside `$transaction(callback)` — the route takes the non-write
 *     branch, so no region should appear (the divergence must be write-only);
 *  2. a FAILING statement-atomic write inside `$transaction(callback)` — the
 *     region rolls back; does the error identity, the caller transaction's
 *     survival and the committed state still match the shipped route?
 *  3. the same write one savepoint deeper (a nested transaction), where the
 *     route opens a region inside a region.
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
  .map("g4r_fu_authors");

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

async function createWorld(route: "shipped" | "candidate"): Promise<World> {
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

async function onBothRoutes<T>(
  scenario: (world: World) => Promise<T>
): Promise<{ candidate: T; shipped: T }> {
  const shipped = await scenario(await createWorld("shipped"));
  const candidate = await scenario(await createWorld("candidate"));
  return { candidate, shipped };
}

const storedAuthors = (world: World) =>
  world.database
    .prepare("SELECT email FROM g4r_fu_authors ORDER BY id")
    .all() as { email: string }[];

describe("G4-03 follow-up — what else the named region does", () => {
  test("a READ inside $transaction(callback) opens no region on either route", async () => {
    const observations = await onBothRoutes(async (world) => {
      await world.client.author.create({
        data: { email: "seed@example.test", name: "Seed" },
      });
      const units: string[] = [];
      const completions: Promise<unknown>[] = [];
      const client = world.client.$extends({
        name: "followup-observer",
        observe(unit, proceed) {
          units.push(`${unit.kind}:${unit.operation}`);
          completions.push(proceed());
        },
      });
      const rows = await client.$transaction(async (tx) =>
        tx.author.findMany({ select: { email: true } })
      );
      await Promise.all(completions);
      return { rows, units };
    });

    assert.deepEqual(observations.candidate.rows, observations.shipped.rows);
    assert.deepEqual(
      observations.candidate.units,
      observations.shipped.units,
      `candidate=${JSON.stringify(observations.candidate.units)} shipped=${JSON.stringify(observations.shipped.units)}`
    );
  });

  test("a FAILING statement-atomic write inside $transaction(callback) keeps the same error identity and the same caller-transaction outcome", async () => {
    const observations = await onBothRoutes(async (world) => {
      await world.client.author.create({
        data: { email: "taken@example.test", name: "Taken" },
      });
      let inner: string | undefined;
      let outer: string | undefined;
      let afterWrite: string | undefined;
      try {
        await world.client.$transaction(async (tx) => {
          await tx.author.create({
            data: { email: "kept@example.test", name: "Kept" },
          });
          try {
            await tx.author.create({
              data: { email: "taken@example.test", name: "Duplicate" },
            });
          } catch (error) {
            inner = `${(error as Error).constructor.name}:${(error as Error).message}`;
          }
          // The caller keeps using its transaction after the failure.
          try {
            await tx.author.create({
              data: { email: "after@example.test", name: "After" },
            });
            afterWrite = "ok";
          } catch (error) {
            afterWrite = `${(error as Error).constructor.name}:${(error as Error).message}`;
          }
        });
      } catch (error) {
        outer = `${(error as Error).constructor.name}:${(error as Error).message}`;
      }
      return { afterWrite, inner, outer, stored: storedAuthors(world) };
    });

    assert.equal(
      `${observations.candidate.inner}|${observations.candidate.afterWrite}|${observations.candidate.outer}`,
      `${observations.shipped.inner}|${observations.shipped.afterWrite}|${observations.shipped.outer}`,
      `candidate=${JSON.stringify(observations.candidate)} shipped=${JSON.stringify(observations.shipped)}`
    );
    assert.deepEqual(
      observations.candidate.stored,
      observations.shipped.stored,
      `candidate=${JSON.stringify(observations.candidate.stored)} shipped=${JSON.stringify(observations.shipped.stored)}`
    );
  });

  test("a statement-atomic write inside a NESTED transaction commits identically on both routes", async () => {
    const observations = await onBothRoutes(async (world) => {
      const units: string[] = [];
      const completions: Promise<unknown>[] = [];
      const client = world.client.$extends({
        name: "followup-nested-observer",
        observe(unit, proceed) {
          units.push(`${unit.kind}:${unit.operation}`);
          completions.push(proceed());
        },
      });
      await client.$transaction(async (tx) => {
        await tx.$transaction(async (inner) => {
          await inner.author.create({
            data: { email: "nested@example.test", name: "Nested" },
          });
        });
      });
      await Promise.all(completions);
      return { stored: storedAuthors(world), units };
    });

    assert.deepEqual(observations.candidate.stored, [
      { email: "nested@example.test" },
    ]);
    assert.deepEqual(observations.candidate.stored, observations.shipped.stored);
    assert.deepEqual(
      observations.candidate.units,
      observations.shipped.units,
      `candidate=${JSON.stringify(observations.candidate.units)} shipped=${JSON.stringify(observations.shipped.units)}`
    );
  });
});
