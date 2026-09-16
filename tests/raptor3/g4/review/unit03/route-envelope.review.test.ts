/**
 * G4-03 independent review probe — the transaction envelope the route opens.
 *
 * The unit's LX-02/LX-03/LX-14 oracles only compare COMMITTED STATE and the
 * OPERATION observer units. They never compare the transaction control
 * statements the two routes issue, nor the non-operation units an observer
 * sees when the route itself opens a region on the CLIENT's trusted context.
 *
 * `runCandidate` (src/query-engine/raptor3/route/client-route.ts:197) opens one
 * `engineDriver.withTransaction(..., execution.context)` for EVERY write whose
 * engine is transaction-bound. The shipped executor
 * (write-engine/OperationExecutor.ts:349 `runStatementAtomic`) opens NO
 * envelope for a statement-atomic write. The probe measures both.
 */

import assert from "node:assert/strict";
import { VibORM, type VibORMClient } from "@client/client";
import type { QueryResult } from "@drivers";
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
  .map("g4r_env_authors");

const schema = { author };

class ControlDriver extends SQLite3Driver {
  readonly statements: string[] = [];

  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[]
  ): Promise<QueryResult<T>> {
    this.statements.push(statement);
    return super.execute<T>(client, statement, parameters);
  }
}

type WorldClient = VibORMClient<{
  driver: ControlDriver;
  schema: typeof schema;
}>;

interface World {
  readonly client: WorldClient;
  readonly database: Database.Database;
  readonly driver: ControlDriver;
}

const worlds: World[] = [];

async function createWorld(route: "shipped" | "candidate"): Promise<World> {
  const database = new Database(":memory:");
  const driver = new ControlDriver({ client: database });
  const config = { driver, schema };
  const client: WorldClient =
    route === "shipped"
      ? createClient(config)
      : VibORM.create(config, createCandidateRoute);
  const migration = await syncLiveSchema(client);
  if (!migration.applied) throw new Error("schema did not apply");
  driver.statements.length = 0;
  const world: World = { client, database, driver };
  worlds.push(world);
  return world;
}

afterEach(async () => {
  for (const world of worlds.splice(0)) {
    await world.client.$disconnect();
    world.database.close();
  }
});

const control = (statements: readonly string[]) =>
  statements.filter((statement) =>
    /^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)/i.test(statement.trim())
  );

async function onBothRoutes<T>(
  scenario: (world: World) => Promise<T>
): Promise<{ candidate: T; shipped: T }> {
  const shipped = await scenario(await createWorld("shipped"));
  const candidate = await scenario(await createWorld("candidate"));
  return { candidate, shipped };
}

describe("G4-03 review — the envelope the route opens", () => {
  /**
   * WEAK CONTROL, kept deliberately: `SQLite3Driver` runs BEGIN/SAVEPOINT
   * through better-sqlite3's own transaction API, not through the `execute`
   * override this driver subclasses, so `control()` sees nothing on either
   * route and this case passes vacuously. The observer case below is the one
   * that actually detects the extra region.
   */
  test("a single-statement write inside $transaction(callback) issues the same control statements on both routes", async () => {
    const observations = await onBothRoutes(async (world) => {
      await world.client.$transaction(async (tx) => {
        await tx.author.create({
          data: { email: "envelope@example.test", name: "Ada" },
        });
      });
      return { control: control(world.driver.statements) };
    });

    // Probe: the candidate adds a SAVEPOINT/RELEASE pair the shipped route
    // does not issue for a statement-atomic write.
    assert.deepEqual(
      observations.candidate.control,
      observations.shipped.control,
      `candidate=${JSON.stringify(observations.candidate.control)} shipped=${JSON.stringify(observations.shipped.control)}`
    );
  });

  test("an observer sees the same non-operation unit kinds inside $transaction(callback) on both routes", async () => {
    const observations = await onBothRoutes(async (world) => {
      const units: string[] = [];
      const completions: Promise<unknown>[] = [];
      const client = world.client.$extends({
        name: "review-observer",
        observe(unit, proceed) {
          units.push(`${unit.kind}:${unit.operation}`);
          completions.push(proceed());
        },
      });
      await client.$transaction(async (tx) => {
        await tx.author.create({
          data: { email: "observed@example.test", name: "Grace" },
        });
      });
      await Promise.all(completions);
      return { units };
    });

    // The unit's own LX-14 oracle asserts the candidate produces NO
    // non-operation unit. Inside a callback transaction the route's own
    // `withTransaction` carries the client's TRUSTED context, so it does — and
    // the shipped route does not produce that unit at all.
    assert.deepEqual(
      observations.candidate.units,
      observations.shipped.units,
      `candidate=${JSON.stringify(observations.candidate.units)} shipped=${JSON.stringify(observations.shipped.units)}`
    );
  });
});
