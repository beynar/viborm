/**
 * G4-03b independent review probe — array members beyond `findMany`.
 *
 * The unit retired divergence D-2 with ONE array cell: a `findMany` member on a
 * batch-only driver. `PreparedRead` publishes four facts (`shape`, `value`,
 * `single`, `empty`) and the derived-value reads are exactly the ones whose
 * PUBLIC value is not the row: `count` publishes a number, `exist` a boolean,
 * `aggregate` a record, `findUnique` a row or `null`, `findUniqueOrThrow` a
 * refusal. Each of those travels through the package's `parseResult`, so each
 * is a separate claim.
 *
 * Also probed: an array nested INSIDE `$transaction(callback)`, which is the
 * one place where the driver the array owner supplies to `prepareBatch` is not
 * the client's factory driver (blocker D-3').
 */

import assert from "node:assert/strict";
import { VibORM, type VibORMClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCandidateRoute } from "@query-engine/raptor3/route/client-route";
import { s } from "@schema";
import { createClient } from "@src/index";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { afterEach, describe, test } from "vitest";

const entry = s
  .model({
    id: s.int().id().increment(),
    label: s.string().unique(),
    score: s.int().default(0),
  })
  .map("g4r3b_arrverb_entries");

const schema = { entry };

class InteractiveDriver extends SQLite3Driver {
  readonly statements: string[] = [];

  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[]
  ): Promise<QueryResult<T>> {
    this.statements.push(statement);
    return super.execute<T>(client, statement, parameters);
  }

  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    for (const query of queries) this.statements.push(query.sql);
    return super.executeBatch<T>(client, queries);
  }
}

class BatchOnlyDriver extends InteractiveDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;

  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    for (const query of queries) this.statements.push(query.sql);
    return this.transaction(client, (transaction) =>
      super.executeBatch<T>(transaction, queries)
    );
  }
}

/** Interactive AND batch-capable: the only shape that reaches `tx.$transaction([…])` natively. */
class BatchAndTransactionDriver extends InteractiveDriver {
  override readonly supportsBatch = true;
}

type WorldClient = VibORMClient<{
  driver: InteractiveDriver;
  schema: typeof schema;
}>;

interface World {
  readonly client: WorldClient;
  readonly database: Database.Database;
  readonly driver: InteractiveDriver;
}

const worlds: World[] = [];

async function createWorld(
  route: "shipped" | "candidate",
  driverKind: "interactive" | "batch-only" | "batch-and-transaction"
): Promise<World> {
  const database = new Database(":memory:");
  const driver: InteractiveDriver =
    driverKind === "interactive"
      ? new InteractiveDriver({ client: database })
      : driverKind === "batch-only"
        ? new BatchOnlyDriver({ client: database })
        : new BatchAndTransactionDriver({ client: database });
  const config = { driver, schema };
  const client = (
    route === "shipped"
      ? createClient(config)
      : VibORM.create(config, createCandidateRoute)
  ) as WorldClient;
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

async function onBothRoutes<T>(
  scenario: (world: World) => Promise<T>,
  driverKind: "interactive" | "batch-only" | "batch-and-transaction"
): Promise<{ candidate: T; shipped: T }> {
  const shipped = await scenario(await createWorld("shipped", driverKind));
  const candidate = await scenario(await createWorld("candidate", driverKind));
  return { candidate, shipped };
}

async function outcome<T>(run: () => PromiseLike<T>): Promise<string> {
  try {
    return `ok:${JSON.stringify(await run())}`;
  } catch (error) {
    return `${(error as Error).constructor.name}: ${(error as Error).message}`;
  }
}

async function seed(world: World): Promise<void> {
  await world.client.entry.createMany({
    data: [
      { label: "a", score: 1 },
      { label: "b", score: 2 },
    ],
  });
  world.driver.statements.length = 0;
}

describe("G4-03b review — array members beyond findMany", () => {
  test("every derived-value read is packaged identically on a batch-only driver", async () => {
    const observations = await onBothRoutes(async (world) => {
      await seed(world);
      const client = world.client;
      const results: Record<string, string> = {
        aggregate: await outcome(() =>
          client.$transaction([
            client.entry.aggregate({ _sum: { score: true } }),
          ])
        ),
        count: await outcome(() => client.$transaction([client.entry.count()])),
        exist: await outcome(() =>
          client.$transaction([client.entry.exist({ where: { label: "a" } })])
        ),
        findUniqueHit: await outcome(() =>
          client.$transaction([
            client.entry.findUnique({
              select: { label: true },
              where: { label: "a" },
            }),
          ])
        ),
        findUniqueMiss: await outcome(() =>
          client.$transaction([
            client.entry.findUnique({ where: { label: "zz" } }),
          ])
        ),
        findUniqueOrThrowMiss: await outcome(() =>
          client.$transaction([
            client.entry.findUniqueOrThrow({ where: { label: "zz" } }),
          ])
        ),
        groupBy: await outcome(() =>
          client.$transaction([
            client.entry.groupBy({
              _count: true,
              by: ["label"],
              orderBy: { label: "asc" },
            }),
          ])
        ),
        mixed: await outcome(() =>
          client.$transaction([
            client.entry.count(),
            client.entry.createMany({ data: [{ label: "c" }] }),
            client.entry.exist({ where: { label: "c" } }),
          ])
        ),
      };
      return results;
    }, "batch-only");

    assert.deepEqual(observations.candidate, observations.shipped);
    // Non-vacuous: these really ran, they were not refused identically.
    assert.deepEqual(observations.candidate.count, "ok:[2]");
    assert.deepEqual(observations.candidate.exist, "ok:[true]");
    assert.deepEqual(observations.candidate.findUniqueMiss, "ok:[null]");
    assert(
      String(observations.candidate.findUniqueOrThrowMiss).startsWith(
        "NotFound"
      )
    );
  });

  test("the same members inside an interactive array agree on both routes", async () => {
    const observations = await onBothRoutes(async (world) => {
      await seed(world);
      const client = world.client;
      return {
        count: await outcome(() => client.$transaction([client.entry.count()])),
        orThrow: await outcome(() =>
          client.$transaction([
            client.entry.findUniqueOrThrow({ where: { label: "zz" } }),
          ])
        ),
      };
    }, "interactive");

    assert.deepEqual(observations.candidate, observations.shipped);
  });

  /**
   * D-3': `prepareBatch(operation, driver)` receives the array owner's driver,
   * and the routed seam drops it — the candidate always prepares on the client's
   * factory driver. The only substrate where those two objects differ is an
   * array nested inside `$transaction(callback)` on a driver that supports BOTH
   * transactions and native batches.
   */
  test("an array nested inside a callback transaction agrees on both routes", async () => {
    const observations = await onBothRoutes(async (world) => {
      await seed(world);
      const units: string[] = [];
      const completions: Promise<unknown>[] = [];
      const client = world.client.$extends({
        name: "nested-array-observer",
        observe(unit, proceed) {
          units.push(`${unit.kind}:${unit.operation}`);
          completions.push(proceed());
        },
      }) as unknown as WorldClient;
      const nested = await outcome(() =>
        client.$transaction(async (tx) => {
          const scoped = tx as unknown as {
            $transaction: (ops: unknown[]) => Promise<unknown>;
            entry: WorldClient["entry"];
          };
          return await scoped.$transaction([
            scoped.entry.create({
              data: { label: "nested-1" },
              select: { label: true },
            }),
            scoped.entry.count(),
          ]);
        })
      );
      await Promise.all(completions);
      return {
        nested,
        stored: world.database
          .prepare("SELECT label FROM g4r3b_arrverb_entries ORDER BY id")
          .all(),
        units,
      };
    }, "batch-and-transaction");

    assert.deepEqual(observations.candidate, observations.shipped);
    // Non-vacuous: the nested array really executed on both routes.
    assert(observations.shipped.nested.startsWith("ok:"));
  });
});
