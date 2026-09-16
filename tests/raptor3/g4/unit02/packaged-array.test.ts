/**
 * G4-02 — a packaged root single-row write keeps the array's atomicity.
 *
 * `OperationContext.published` owns the missing-row failure for root `update`
 * and root `delete`. That is a JavaScript postcondition, and a PACKAGED
 * operation only reaches its parser after `$transaction([...])` has already
 * submitted and committed its one batch — so the premise has to travel as a
 * statement instead. `packagedPresence` queues the same `assertions.exists`
 * guard the shipped fold puts in front of its mutation
 * (`DeleteOperation.buildRootPresenceGuard`) and declares it to the array owner,
 * which aborts the whole batch and reconstructs this operation's own
 * `NotFoundError`.
 *
 * These checks compare the candidate route with the shipped one on the same
 * batch-only driver: same rejection, same surviving rows.
 */

import assert from "node:assert/strict";
import { VibORM, type VibORMClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { createCandidateRoute } from "@query-engine/raptor3/route/client-route";
import { s } from "@schema";
import { createClient } from "@src/index";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { afterEach, describe, it } from "vitest";

const author = s
  .model({
    id: s.int().id().increment(),
    email: s.string().unique(),
    name: s.string(),
  })
  .map("g4u2_packaged_authors");

const schema = { author };

/** No callback transactions, one atomic batch — the `$transaction([...])` shape. */
class BatchOnlyDriver extends SQLite3Driver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;

  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
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

const PRESENCE_GUARD = /EXISTS/;
const ROOT_DELETE = /^DELETE\b/;

const worlds: World[] = [];

afterEach(async () => {
  for (const world of worlds.splice(0)) {
    await world.client.$disconnect();
    world.database.close();
  }
});

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
  const world = { client, database, driver } as World;
  worlds.push(world);
  return world;
}

function stored(world: World): unknown[] {
  return world.database
    .prepare("SELECT email FROM g4u2_packaged_authors ORDER BY id")
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
    code: (rejection as { code?: string } | undefined)?.code,
    stored: stored(world),
  };
}

describe("G4-02 packaged root cardinality", () => {
  it("a missing root delete aborts the array exactly as the shipped engine does", async () => {
    const shipped = await arrayOutcome(await createWorld("shipped"), (c) => [
      c.author.delete({ where: { id: 9999 } }),
      c.author.create({ data: { email: "sibling@example.test", name: "Bo" } }),
    ]);
    const candidate = await arrayOutcome(await createWorld("candidate"), (c) => [
      c.author.delete({ where: { id: 9999 } }),
      c.author.create({ data: { email: "sibling@example.test", name: "Bo" } }),
    ]);
    assert.equal(candidate.rejected, shipped.rejected);
    assert.equal(candidate.code, shipped.code);
    assert.deepEqual(
      candidate.stored,
      shipped.stored,
      `candidate ${JSON.stringify(candidate.stored)} vs shipped ${JSON.stringify(shipped.stored)}`
    );
  });

  it("a missing root update aborts the array exactly as the shipped engine does", async () => {
    const shipped = await arrayOutcome(await createWorld("shipped"), (c) => [
      c.author.update({ where: { id: 9999 }, data: { name: "X" } }),
      c.author.create({ data: { email: "sibling@example.test", name: "Bo" } }),
    ]);
    const candidate = await arrayOutcome(await createWorld("candidate"), (c) => [
      c.author.update({ where: { id: 9999 }, data: { name: "X" } }),
      c.author.create({ data: { email: "sibling@example.test", name: "Bo" } }),
    ]);
    assert.equal(candidate.rejected, shipped.rejected);
    assert.equal(candidate.code, shipped.code);
    assert.deepEqual(candidate.stored, shipped.stored);
  });

  it("a present root delete still commits the whole array", async () => {
    const shipped = await arrayOutcome(await createWorld("shipped"), (c) => [
      c.author.delete({ where: { email: "present@example.test" } }),
      c.author.create({ data: { email: "sibling@example.test", name: "Bo" } }),
    ]);
    const candidate = await arrayOutcome(await createWorld("candidate"), (c) => [
      c.author.delete({ where: { email: "present@example.test" } }),
      c.author.create({ data: { email: "sibling@example.test", name: "Bo" } }),
    ]);
    assert.equal(shipped.rejected, "none");
    assert.equal(candidate.rejected, "none");
    assert.deepEqual(candidate.stored, shipped.stored);
  });

  it("the packaged plan is the shipped batch shape: presence guard, then the mutation", async () => {
    const world = await createWorld("candidate");
    const engine = createCommandEngine({ schema, driver: world.driver });
    const packaged = await engine.prepareBatch("author", "delete", {
      where: { id: 9999 },
    });
    assert.ok(packaged, "a folded root delete must stay packageable");
    assert.equal(packaged.queries.length, 2);
    assert.match(packaged.queries[0]!.sql, PRESENCE_GUARD);
    assert.match(packaged.queries[1]!.sql, ROOT_DELETE);
    assert.deepEqual(
      (packaged.guards ?? []).map((guard) => ({
        queryIndex: guard.queryIndex,
        premise: guard.premise,
        model: guard.model,
        operation: guard.operation,
        kind: guard.failure.kind,
      })),
      [
        {
          queryIndex: 0,
          premise: "exists",
          model: "author",
          operation: "delete",
          kind: "notFound",
        },
      ]
    );
  });

  it("a bulk delete carries no presence premise", async () => {
    const world = await createWorld("candidate");
    const engine = createCommandEngine({ schema, driver: world.driver });
    const packaged = await engine.prepareBatch("author", "deleteMany", {
      where: { id: 9999 },
    });
    assert.ok(packaged);
    assert.equal(packaged.queries.length, 1);
    assert.deepEqual(packaged.guards, undefined);
  });
});
