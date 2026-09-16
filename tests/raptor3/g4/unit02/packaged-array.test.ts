/**
 * G4-02 — a packaged root single-row write keeps the array's atomicity.
 *
 * `OperationContext.published` owns the missing-row failure for root `update`
 * and root `delete`. That is a JavaScript postcondition, and a PACKAGED
 * operation only reaches its parser after `$transaction([...])` has already
 * submitted and committed its one batch — so the premise has to travel as a
 * statement instead. `packagedPresence` queues an `assertions.exists` guard in
 * front of its mutation and declares it to the array owner, which aborts the
 * whole batch and reconstructs this operation's own `NotFoundError`.
 *
 * ## What the C-01 cutover changed here
 *
 * This file used to build a SHIPPED client and a CANDIDATE client on the same
 * batch-only driver. After C-01 there is no shipped client: `createClient` IS
 * the candidate, so a comparison between the two arms would compare the engine
 * with itself and report green forever. The rule applied here, and recorded in
 * `g4/cutover-execution/note.md`, is: remove the shipped arm and every
 * assertion that referenced it; a cell with at least one surviving verbatim
 * assertion is kept and renamed to what it now claims, a cell with none is
 * retired.
 *
 * RETIRED (nothing survived the shipped arm's removal):
 *   1. "a missing root delete aborts the array exactly as the shipped engine does"
 *   2. "a missing root update aborts the array exactly as the shipped engine does"
 *
 * KEPT: the present-root-delete cell (its `rejected === "none"` pin survives,
 * its cross-engine row comparison does not) and the two prepared-batch pins,
 * which only ever used `createCandidateRoute` to REACH the engine and now
 * reach it through the public `createClient`.
 */

import assert from "node:assert/strict";
import type { VibORMClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCommandEngine } from "@query-engine/raptor3/commands";
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

async function createWorld(): Promise<World> {
  const database = new Database(":memory:");
  const driver = new BatchOnlyDriver({ client: database });
  const client = createClient({ driver, schema });
  const migration = await syncLiveSchema(client);
  if (!migration.applied) throw new Error("schema did not apply");
  await client.author.create({
    data: { email: "present@example.test", name: "Ada" },
  });
  const world = { client, database, driver } as World;
  worlds.push(world);
  return world;
}

async function arrayOutcome(
  world: World,
  members: (client: World["client"]) => readonly PromiseLike<unknown>[]
) {
  let rejection: unknown;
  try {
    await (
      world.client as unknown as {
        $transaction(
          members: readonly PromiseLike<unknown>[]
        ): Promise<unknown>;
      }
    ).$transaction(members(world.client));
  } catch (error) {
    rejection = error;
  }
  return {
    rejected: rejection === undefined ? "none" : (rejection as Error).name,
    code: (rejection as { code?: string } | undefined)?.code,
  };
}

describe("G4-02 packaged root cardinality", () => {
  it("a present root delete does not reject the array", async () => {
    const outcome = await arrayOutcome(await createWorld(), (c) => [
      c.author.delete({ where: { email: "present@example.test" } }),
      c.author.create({ data: { email: "sibling@example.test", name: "Bo" } }),
    ]);
    assert.equal(outcome.rejected, "none");
  });

  it("the packaged plan is the shipped batch shape: presence guard, then the mutation", async () => {
    const world = await createWorld();
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
    const world = await createWorld();
    const engine = createCommandEngine({ schema, driver: world.driver });
    const packaged = await engine.prepareBatch("author", "deleteMany", {
      where: { id: 9999 },
    });
    assert.ok(packaged);
    assert.equal(packaged.queries.length, 1);
    assert.deepEqual(packaged.guards, undefined);
  });
});
