/**
 * G4-03 independent review probe — array transactions that contain a READ.
 *
 * The unit's LX-04 oracles use write-only arrays. On a batch-only driver the
 * array owner asks each member for a single prepared statement first
 * (`owner.prepare`), and `PendingOperation.#resolveSinglePlan` now returns
 * `undefined` for EVERY routed operation (pending-operation.ts:602), so every
 * member must answer through `prepareBatch()`. A candidate READ under
 * `batch-preparation` ownership throws `incompletePreparation`
 * (raptor3/shared/operation-context.ts:315), which `createCommandEngine`
 * converts to `undefined` (commands/index.ts:96) — i.e. "unbatchable".
 *
 * The shipped route batches the same read as one statement.
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
  .map("g4r_arr_authors");

const schema = { author };

class BatchOnlyDriver extends SQLite3Driver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
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
    return this.transaction(client, (transaction) =>
      super.executeBatch<T>(transaction, queries)
    );
  }
}

type WorldClient = VibORMClient<{
  driver: BatchOnlyDriver;
  schema: typeof schema;
}>;

const closers: (() => Promise<void>)[] = [];

async function createWorld(route: "shipped" | "candidate") {
  const database = new Database(":memory:");
  const driver = new BatchOnlyDriver({ client: database });
  const config = { driver, schema };
  const client = (
    route === "shipped"
      ? createClient(config)
      : VibORM.create(config, createCandidateRoute)
  ) as WorldClient;
  const migration = await syncLiveSchema(client);
  if (!migration.applied) throw new Error("schema did not apply");
  driver.statements.length = 0;
  closers.push(async () => {
    await client.$disconnect();
    database.close();
  });
  return { client, database, driver };
}

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function outcome<T>(run: () => Promise<T>): Promise<string> {
  try {
    return `ok:${JSON.stringify(await run())}`;
  } catch (error) {
    return `${(error as Error).constructor.name}:${(error as Error).message}`;
  }
}

describe("G4-03 review — array transactions containing a read", () => {
  test("a read-only array transaction on a batch-only driver behaves the same on both routes", async () => {
    const results: Record<string, string> = {};
    for (const route of ["shipped", "candidate"] as const) {
      const world = await createWorld(route);
      await world.client.author.create({
        data: { email: "read-array@example.test", name: "Ada" },
      });
      results[route] = await outcome(() =>
        world.client.$transaction([
          world.client.author.findMany({ select: { email: true } }),
        ])
      );
    }
    assert.equal(
      results.candidate,
      results.shipped,
      `candidate=${results.candidate}\nshipped=${results.shipped}`
    );
  });

  test("a mixed read+write array transaction on a batch-only driver behaves the same on both routes", async () => {
    const results: Record<string, string> = {};
    for (const route of ["shipped", "candidate"] as const) {
      const world = await createWorld(route);
      results[route] = await outcome(() =>
        world.client.$transaction([
          world.client.author.create({
            data: { email: "mixed-write@example.test", name: "Write" },
          }),
          world.client.author.findMany({ select: { email: true } }),
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
