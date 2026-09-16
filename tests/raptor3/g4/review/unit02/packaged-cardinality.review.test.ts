/**
 * G4-02 independent review — packaged root-verb cardinality on a batch-only
 * driver.
 *
 * The unit made root `delete`/`update` fold onto the set-oriented owner and
 * publish ONE row plus a `NotFoundError` raised by `OperationContext.published`.
 * Under `prepareBatch` that decision travels inside `parseResult`, which the
 * array owner runs AFTER the batch has been submitted and committed. The shipped
 * engine instead puts a PRESENCE GUARD inside the same batch
 * (`DeleteOperation.buildRootPresenceGuard`, `UpdateOperation` fold guard), so a
 * missing row aborts the whole atomic unit.
 *
 * These probes compare the two routes on the same batch-only driver.
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

const author = s
  .model({
    id: s.int().id().increment(),
    email: s.string().unique(),
    name: s.string(),
  })
  .map("rv2_authors");

const schema = { author };

class BatchOnlyDriver extends SQLite3Driver {
  readonly statements: string[] = [];
  readonly batches: BatchQuery[][] = [];
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;

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
    this.batches.push(queries);
    for (const query of queries) this.statements.push(query.sql);
    return this.transaction(client, (transaction) =>
      super.executeBatch<T>(transaction, queries)
    );
  }
}

interface World {
  readonly client: VibORMClient<{
    driver: BatchOnlyDriver;
    schema: typeof schema;
  }>;
  readonly database: Database.Database;
  readonly driver: BatchOnlyDriver;
}

const worlds: World[] = [];

async function createWorld(route: "shipped" | "candidate"): Promise<World> {
  const database = new Database(":memory:");
  const driver = new BatchOnlyDriver({ client: database });
  const config = { driver, schema };
  const client =
    route === "shipped"
      ? createClient(config)
      : VibORM.create(config, createCandidateRoute);
  const migration = await syncLiveSchema(client);
  if (!migration.applied) throw new Error("schema did not apply");
  await client.author.create({
    data: { email: "present@example.test", name: "Ada" },
  });
  driver.statements.length = 0;
  driver.batches.length = 0;
  const world = { client, database, driver } as World;
  worlds.push(world);
  return world;
}

afterEach(async () => {
  for (const world of worlds.splice(0)) {
    await world.client.$disconnect();
    world.database.close();
  }
});

function stored(world: World): unknown[] {
  return world.database
    .prepare("SELECT email FROM rv2_authors ORDER BY id")
    .all();
}

async function arrayOutcome(
  world: World,
  members: (client: World["client"]) => readonly PromiseLike<unknown>[]
) {
  let rejection: unknown;
  try {
    // biome-ignore lint/suspicious/noExplicitAny: the array seam is structural here.
    await (world.client as any).$transaction(members(world.client));
  } catch (error) {
    rejection = error;
  }
  return {
    rejected: rejection === undefined ? "none" : (rejection as Error).name,
    stored: stored(world),
    batches: world.driver.batches.length,
  };
}

describe("G4-02 review — packaged root cardinality", () => {
  test("a missing root delete inside an array must not let a sibling write commit", async () => {
    const shipped = await arrayOutcome(await createWorld("shipped"), (c) => [
      c.author.delete({ where: { id: 9999 } }),
      c.author.create({ data: { email: "sibling@example.test", name: "Bo" } }),
    ]);
    const candidate = await arrayOutcome(await createWorld("candidate"), (c) => [
      c.author.delete({ where: { id: 9999 } }),
      c.author.create({ data: { email: "sibling@example.test", name: "Bo" } }),
    ]);
    // eslint-disable-next-line no-console
    console.log("DELETE shipped", JSON.stringify(shipped));
    // eslint-disable-next-line no-console
    console.log("DELETE candidate", JSON.stringify(candidate));
    assert.deepEqual(candidate.stored, shipped.stored);
    assert.equal(candidate.rejected, shipped.rejected);
  });

  test("a missing root update inside an array must not let a sibling write commit", async () => {
    const shipped = await arrayOutcome(await createWorld("shipped"), (c) => [
      c.author.update({ where: { id: 9999 }, data: { name: "X" } }),
      c.author.create({ data: { email: "sibling@example.test", name: "Bo" } }),
    ]);
    const candidate = await arrayOutcome(await createWorld("candidate"), (c) => [
      c.author.update({ where: { id: 9999 }, data: { name: "X" } }),
      c.author.create({ data: { email: "sibling@example.test", name: "Bo" } }),
    ]);
    // eslint-disable-next-line no-console
    console.log("UPDATE shipped", JSON.stringify(shipped));
    // eslint-disable-next-line no-console
    console.log("UPDATE candidate", JSON.stringify(candidate));
    assert.deepEqual(candidate.stored, shipped.stored);
    assert.equal(candidate.rejected, shipped.rejected);
  });

  test("a missing findUniqueOrThrow inside an array must not let a sibling write commit", async () => {
    const shipped = await arrayOutcome(await createWorld("shipped"), (c) => [
      c.author.findUniqueOrThrow({ where: { id: 9999 } }),
      c.author.create({ data: { email: "sibling@example.test", name: "Bo" } }),
    ]);
    const candidate = await arrayOutcome(await createWorld("candidate"), (c) => [
      c.author.findUniqueOrThrow({ where: { id: 9999 } }),
      c.author.create({ data: { email: "sibling@example.test", name: "Bo" } }),
    ]);
    // eslint-disable-next-line no-console
    console.log("ORTHROW shipped", JSON.stringify(shipped));
    // eslint-disable-next-line no-console
    console.log("ORTHROW candidate", JSON.stringify(candidate));
    assert.deepEqual(candidate.stored, shipped.stored);
    assert.equal(candidate.rejected, shipped.rejected);
  });
});
